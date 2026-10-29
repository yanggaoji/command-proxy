import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  note,
  outro,
  select,
  spinner,
  text,
} from '@clack/prompts';
import {
  allocateProjectId,
  projectSlug,
  saveConfig,
  unsafeProjectRootReason,
} from './config.js';
import { CancelledError, CliError } from './errors.js';
import {
  collectIgnorePatterns,
  createIgnoreMatcher,
  ensureGlobalIgnoreFile,
  hashIgnorePatterns,
} from './ignore.js';
import { warn } from './log.js';
import {
  buildManagedBlock,
  getSshConfigPath,
  isValidAlias,
  normalizePort,
  parseSshDestination,
  readRemoteHome,
  readResolvedSshConfig,
  remoteDirectoryState,
  remoteRootProblem,
  resolveRemoteRoot,
  testSshConnection,
  upsertManagedBlock,
} from './sshconfig.js';
import {
  ensureSession,
  flushSession,
  getSessionInfo,
  sessionName,
  warnAboutConflicts,
} from './sync.js';

export function canPrompt() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * @template T
 * @param {T | symbol} value
 * @returns {T}
 */
function unwrap(value) {
  if (isCancel(value)) {
    cancel('Setup cancelled.');
    throw new CancelledError();
  }
  return value;
}

async function probeConnection(target, label) {
  const status = spinner();
  status.start(label);
  let result;
  while (true) {
    result = readRemoteHome(target);
    if (result.ok) {
      break;
    }
    status.error('Connection failed');
    const detail = (result.stderr || '').trim();
    if (detail) {
      warn(detail);
    } else if (result.error) {
      warn(result.error.message);
    }
    if (result.timedOut) {
      warn('the connection attempt timed out');
    }
    printConnectionHint(detail);
    const retry = unwrap(
      await confirm({
        message: 'Try the connection again?',
        active: 'Retry',
        inactive: 'Abort',
        initialValue: true,
      }),
    );
    if (!retry) {
      cancel('Setup cancelled.');
      throw new CancelledError();
    }
    status.start(label);
  }
  status.stop(`Connected (remote home: ${result.home})`);
  return result;
}

function printConnectionHint(stderr) {
  const text = String(stderr || '').toLowerCase();
  if (text.includes('host key verification failed')) {
    warn('run `ssh <destination>` once in a terminal to accept the host key, then retry.');
  } else if (text.includes('permission denied')) {
    warn(
      'set up key-based login (for example with ssh-copy-id) and check the user, port, and key file. ' +
        'If the key has a passphrase, load it into ssh-agent.',
    );
  } else if (text.includes('timed out') || text.includes('operation timed out')) {
    warn('check the network, host, port, and firewall.');
  } else if (text.includes('could not resolve hostname')) {
    warn('check the host name or SSH alias.');
  } else if (text) {
    warn('check your SSH configuration and network.');
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}

/**
 * Approximate count of files/size after ignore rules, used only to warn before
 * syncing a very large directory.
 *
 * @param {string} root
 * @param {string[]} patterns
 * @param {{ maxFiles?: number, maxBytes?: number }} [options]
 */
export function scanDirectory(root, patterns, options = {}) {
  const maxFiles = options.maxFiles ?? 50_000;
  const maxBytes = options.maxBytes ?? 1024 * 1024 * 1024;
  const isIgnored = createIgnoreMatcher(patterns);
  const stack = [''];
  let files = 0;
  let bytes = 0;

  while (stack.length > 0) {
    const relativeDir = stack.pop();
    let entries;
    try {
      entries = readdirSync(relativeDir ? path.join(root, relativeDir) : root, {
        withFileTypes: true,
      });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (!isIgnored(relative, true)) {
          stack.push(relative);
        }
        continue;
      }
      if (isIgnored(relative, false)) {
        continue;
      }

      if (entry.isSymbolicLink()) {
        files += 1;
      } else if (entry.isFile()) {
        files += 1;
        try {
          bytes += statSync(path.join(root, relative)).size;
        } catch {
          // A file may disappear while scanning; the count is advisory.
        }
      }

      if (files > maxFiles || bytes > maxBytes) {
        return { files, bytes, limitExceeded: true };
      }
    }
  }

  return { files, bytes, limitExceeded: false };
}

/**
 * Interactive first-run/re-init wizard.
 *
 * @param {{
 *   root: string,
 *   existing: { rootKey: string, project: any } | null,
 *   config: { projects: Record<string, any> },
 *   paths: any,
 * }} options
 */
export async function runWizard(options) {
  const { root, existing, config, paths } = options;

  if (!canPrompt()) {
    throw new CliError('setup requires an interactive terminal', 70, {
      hint: 'Run command-proxy --init from a terminal.',
    });
  }

  const reason = unsafeProjectRootReason(root);
  if (reason) {
    throw new CliError(`refusing to use ${root} as a project root: ${reason}.`, 70, {
      hint: 'Change into a project directory and try again.',
    });
  }

  intro('command-proxy');
  ensureGlobalIgnoreFile(paths);

  if (existing) {
    note(
      `Project: ${root}\nCurrent remote: ${existing.project.sshAlias}:${existing.project.remoteRoot}`,
      'Reconfiguring existing project',
    );
  }

  const id = allocateProjectId(root, config.projects, existing?.project.id);
  const slug = projectSlug(root);

  const connectionMode = unwrap(
    await select({
      message: 'How do you connect to the remote server?',
      options: [
        {
          value: 'alias',
          label: 'Use an alias from ~/.ssh/config',
          hint: 'recommended; your existing SSH settings are used as-is',
        },
        {
          value: 'host',
          label: 'Enter user@host',
          hint: 'adds a managed block to ~/.ssh/config',
        },
      ],
      initialValue: 'alias',
    }),
  );

  let alias;
  let directTarget;
  let hostInfo = null;

  if (connectionMode === 'alias') {
    const value = unwrap(
      await text({
        message: 'SSH alias from ~/.ssh/config',
        placeholder: existing?.project.sshAlias || 'myserver',
        initialValue: existing?.project.sshAlias || '',
        validate: (input) => {
          const trimmed = input.trim();
          if (!trimmed) {
            return 'Enter an SSH alias';
          }
          if (!isValidAlias(trimmed)) {
            return 'Use only letters, numbers, dots, dashes, and underscores';
          }
          return undefined;
        },
      }),
    );
    alias = value.trim();
    const resolved = readResolvedSshConfig(alias);
    note(
      [
        `HostName: ${resolved.hostname || alias}`,
        `User: ${resolved.user || '(ssh default)'}`,
        `Port: ${resolved.port || '22'}`,
        resolved.identityfile ? `IdentityFile: ${resolved.identityfile}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      `Connection: ${alias}`,
    );
    directTarget = alias;
  } else {
    const destinationInput = unwrap(
      await text({
        message: 'SSH destination (user@host, optionally with :port)',
        placeholder: 'dev@example.com:22',
        validate: (input) =>
          parseSshDestination(input)
            ? undefined
            : 'Enter user@host, optionally followed by :port',
      }),
    );
    const destination = parseSshDestination(destinationInput);

    const portInput = unwrap(
      await text({
        message: 'SSH port',
        initialValue: String(destination.port),
        validate: (input) =>
          normalizePort(input) === null ? 'Enter a port between 1 and 65535' : undefined,
      }),
    );
    const identityInput = unwrap(
      await text({
        message: 'Private key file (optional)',
        placeholder: '~/.ssh/id_ed25519 (leave empty to use ssh defaults or an agent)',
        defaultValue: '',
      }),
    );

    hostInfo = {
      hostname: destination.hostname,
      user: destination.user,
      port: normalizePort(portInput),
      identityFile: identityInput.trim(),
    };
    alias = `cp-${slug}-${id}`;
    directTarget = hostInfo;
  }

  const probe = await probeConnection(directTarget, `Connecting to ${alias}`);
  const home = probe.home;

  if (hostInfo) {
    note(
      [
        `HostName: ${hostInfo.hostname}`,
        `User: ${hostInfo.user}`,
        `Port: ${hostInfo.port}`,
        `IdentityFile: ${hostInfo.identityFile || '(ssh default)'}`,
      ].join('\n'),
      `Connection: ${alias}`,
    );
  }

  const defaultRemote =
    existing?.project.remoteRoot || `~/.command-proxy/${slug}-${id}`;
  let remoteRoot;

  while (true) {
    const remoteInput = unwrap(
      await text({
        message: 'Remote directory',
        initialValue: defaultRemote,
        placeholder: '~/.command-proxy/...',
        validate: (input) => (input.trim() ? undefined : 'Enter a remote directory'),
      }),
    );
    const candidate = resolveRemoteRoot(home, remoteInput);
    const problem = remoteRootProblem(home, candidate);
    if (problem) {
      log.error(problem);
      continue;
    }

    const status = spinner();
    status.start('Checking the remote directory...');
    let state;
    try {
      state = remoteDirectoryState(directTarget, candidate);
    } catch (err) {
      status.error('Could not inspect the remote directory');
      throw err;
    }

    if (state === 'missing') {
      status.stop('Remote directory does not exist yet; it will be created.');
    } else if (state === 'empty') {
      status.stop('Remote directory is empty.');
    } else if (state === 'nonempty') {
      status.stop('Remote directory is not empty.');
    } else if (state === 'unreadable') {
      status.error(`Cannot read ${candidate}; check its permissions.`);
      continue;
    } else {
      status.error(`${candidate} exists but is not a directory.`);
      continue;
    }

    if (state === 'nonempty' && candidate !== existing?.project.remoteRoot) {
      note(
        `${candidate} already contains files. It will be merged with the local directory.`,
        'Remote directory',
      );
      const proceed = unwrap(
        await confirm({
          message: 'Continue with this directory?',
          initialValue: true,
        }),
      );
      if (!proceed) {
        continue;
      }
    }

    remoteRoot = candidate;
    break;
  }

  const shellMode = unwrap(
    await select({
      message: 'Remote shell mode',
      options: [
        {
          value: 'login',
          label: 'Login shell (recommended)',
          hint: 'loads nvm, pyenv, and PATH settings from login profiles',
        },
        {
          value: 'plain',
          label: 'Plain shell',
          hint: 'use this if the login shell is csh or otherwise incompatible',
        },
      ],
      initialValue: existing?.project.shellMode === 'plain' ? 'plain' : 'login',
    }),
  );

  const patterns = collectIgnorePatterns(root, paths);
  const scanStatus = spinner();
  scanStatus.start('Scanning local files...');
  const scan = scanDirectory(root, patterns);
  scanStatus.stop(
    `Found ${scan.files.toLocaleString()} file${scan.files === 1 ? '' : 's'} (${formatBytes(scan.bytes)}).`,
  );

  if (scan.limitExceeded) {
    note(
      `The directory has more than 50,000 files or 1 GB of data (after applying ignore rules).\n` +
        'Synchronizing it may take a long time and use significant disk space on the remote server.',
      'Large directory',
    );
    const proceed = unwrap(
      await confirm({
        message: 'Sync this directory anyway?',
        initialValue: false,
      }),
    );
    if (!proceed) {
      cancel('Setup cancelled.');
      throw new CancelledError();
    }
  }

  if (hostInfo) {
    const block = buildManagedBlock(id, { alias, ...hostInfo });
    note(block, `Append to ${getSshConfigPath()}`);
    const proceed = unwrap(
      await confirm({
        message: 'Write this block to ~/.ssh/config?',
        initialValue: true,
      }),
    );
    if (!proceed) {
      cancel('Setup cancelled.');
      throw new CancelledError();
    }

    const { backupPath } = upsertManagedBlock(id, block);
    if (backupPath) {
      log.info(`Backup of the previous SSH config: ${backupPath}`);
    }

    const verify = testSshConnection(alias, 'true');
    if (!verify.ok) {
      const detail = (verify.stderr || '').trim() || verify.error?.message || 'ssh failed';
      throw new CliError(`the new SSH alias ${alias} is not usable: ${detail}`, 70, {
        hint: `Check ${getSshConfigPath()} and run \`ssh ${alias} true\` manually.`,
      });
    }
  }

  const project = {
    id,
    sshAlias: alias,
    remoteRoot,
    shellMode,
    ignoreHash: hashIgnorePatterns(patterns),
  };

  const rootKey = existing?.rootKey || root;
  config.projects[rootKey] = project;
  saveConfig(config, paths);

  const syncStatus = spinner();
  syncStatus.start('Creating the sync session...');
  const activeSessionName = sessionName(project);
  const forceRebuild =
    Boolean(existing) &&
    (Boolean(hostInfo) ||
      alias !== existing.project.sshAlias ||
      remoteRoot !== existing.project.remoteRoot);
  try {
    await ensureSession(root, project, { paths, config, patterns, forceRebuild });
    syncStatus.message('Syncing files...');
    const flushed = flushSession(activeSessionName, { timeoutMs: 60_000 });
    if (flushed.timedOut) {
      syncStatus.stop('Initial sync is still running in the background.');
    } else if (!flushed.ok) {
      syncStatus.error(`Initial sync failed: ${flushed.message}`);
    } else {
      syncStatus.stop('Files are in sync.');
    }
  } catch (err) {
    syncStatus.error(err.message);
    throw err;
  }

  try {
    const session = getSessionInfo(activeSessionName);
    if (session) {
      warnAboutConflicts(session);
    }
  } catch (err) {
    warn(`could not read sync status after setup: ${err.message}`);
  }

  outro('Ready. Run a command with: command-proxy <command>');
  return project;
}

#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgv } from '../src/args.js';
import {
  findProject,
  getPaths,
  loadConfig,
  realPath,
  remoteDirFor,
  saveConfig,
  unsafeProjectRootReason,
} from '../src/config.js';
import { CancelledError, CliError, UsageError } from '../src/errors.js';
import { collectIgnorePatterns, ensureGlobalIgnoreFile } from '../src/ignore.js';
import { error as logError, progress, warn } from '../src/log.js';
import { runRemoteCommand, shQuote } from '../src/run.js';
import {
  checkSshClient,
  removeManagedBlock,
} from '../src/sshconfig.js';
import {
  checkMutagen,
  describeStatus,
  ensureSession,
  flushSession,
  getSessionInfo,
  mutagenVersionTooOld,
  sessionName,
  terminateSession,
  warnAboutConflicts,
  withProjectLock,
} from '../src/sync.js';
import { canPrompt, runWizard } from '../src/wizard.js';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

const MUTAGEN_HINT = [
  'Re-run `npm rebuild command-proxy` (add -g for a global install) to retry',
  'the automatic download, or install Mutagen 0.15 or newer on PATH:',
  '  macOS/Linux: brew install mutagen-io/mutagen/mutagen',
  '  Windows: scoop install mutagen, or download it from',
  '           https://github.com/mutagen-io/mutagen/releases/latest',
].join('\n');

const SSH_HINT = [
  'Install an OpenSSH client and make sure `ssh` is on PATH:',
  '  Windows: Settings > System > Optional features > OpenSSH Client',
  '  macOS: ssh is included with macOS; check that /usr/bin is on PATH',
  '  Linux: install the openssh-client package for your distribution',
].join('\n');

function requireSsh() {
  const ssh = checkSshClient();
  if (!ssh.available) {
    throw new CliError(`ssh is not usable: ${ssh.reason}`, 70, { hint: SSH_HINT });
  }
}

function requireMutagen() {
  const mutagen = checkMutagen();
  if (!mutagen.available) {
    throw new CliError(`Mutagen is not usable: ${mutagen.reason}`, 70, {
      hint: MUTAGEN_HINT,
    });
  }
  if (mutagenVersionTooOld(mutagen.version)) {
    throw new CliError(
      `Mutagen ${mutagen.version} is too old; version 0.15 or newer is required.`,
      70,
      { hint: 'Upgrade Mutagen and try again.' },
    );
  }
}

function requireProject(cwd, config) {
  const found = findProject(cwd, config);
  if (!found) {
    throw new CliError(
      'no command-proxy project found in this directory or its parents.',
      70,
      { hint: 'Run command-proxy --init to configure this directory.' },
    );
  }
  return found;
}

function assertSafeRoot(root) {
  const reason = unsafeProjectRootReason(root);
  if (reason) {
    throw new CliError(`refusing to use ${root} as a project root: ${reason}.`, 70, {
      hint: 'Change into a project directory and try again.',
    });
  }
}

function runIgnore(paths) {
  ensureGlobalIgnoreFile(paths);
  const editor =
    process.env.VISUAL ||
    process.env.EDITOR ||
    (process.platform === 'win32' ? 'notepad' : 'vi');
  const quoted =
    process.platform === 'win32'
      ? `"${paths.ignorePath.replace(/"/g, '""')}"`
      : shQuote(paths.ignorePath);
  const result = spawnSync(`${editor} ${quoted}`, {
    stdio: 'inherit',
    shell: true,
  });

  if (result.error) {
    throw new CliError(`could not open editor "${editor}": ${result.error.message}`, 70, {
      hint: `Edit ${paths.ignorePath} manually or set $EDITOR.`,
    });
  }
  if (result.status === 127 || result.status === 9009) {
    throw new CliError(`editor "${editor}" was not found`, 70, {
      hint: `Set $EDITOR or edit ${paths.ignorePath} manually.`,
    });
  }
  if (result.status !== 0) {
    warn(`the editor exited with status ${result.status}`);
  }

  logError(`Ignore file: ${paths.ignorePath}`);
  logError(`Project-specific patterns can be added to .command-proxyignore in the project root.`);
  logError('Changes take effect on the next run; the sync session is rebuilt automatically.');
  return 0;
}

async function main() {
  const parsed = parseArgv(process.argv.slice(2));

  if (parsed.action === 'help') {
    printHelp();
    return 0;
  }
  if (parsed.action === 'version') {
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }

  const paths = getPaths();

  if (parsed.action === 'ignore') {
    return runIgnore(paths);
  }

  const config = loadConfig(paths);
  const cwd = realPath(process.cwd());

  if (parsed.action === 'init') {
    requireSsh();
    requireMutagen();
    const existing = findProject(cwd, config);
    const root = existing?.root || cwd;
    assertSafeRoot(root);
    if (!canPrompt()) {
      throw new CliError('setup requires an interactive terminal', 70, {
        hint: 'Run command-proxy --init from a terminal.',
      });
    }
    await runWizard({ root, existing, config, paths });
    return 0;
  }

  if (parsed.action === 'status') {
    const found = requireProject(cwd, config);
    requireMutagen();
    const session = getSessionInfo(sessionName(found.project));
    process.stdout.write(
      `${describeStatus(found.root, found.project, session, { cwd })}\n`,
    );
    return 0;
  }

  if (parsed.action === 'sync') {
    requireSsh();
    requireMutagen();
    const found = requireProject(cwd, config);
    const patterns = collectIgnorePatterns(found.root, paths);

    progress('Preparing the sync session...');
    await ensureSession(found.root, found.project, { paths, config, patterns });

    progress('Syncing...');
    const flushed = flushSession(sessionName(found.project));
    if (flushed.timedOut) {
      warn(`${flushed.message}; Mutagen will keep syncing in the background.`);
    } else if (!flushed.ok) {
      throw new CliError(`sync failed: ${flushed.message}`, 70, {
        hint: 'Run command-proxy --status for details.',
      });
    }

    const session = getSessionInfo(sessionName(found.project));
    if (session) {
      warnAboutConflicts(session);
    }
    return 0;
  }

  if (parsed.action === 'reset') {
    const found = requireProject(cwd, config);
    requireMutagen();

    await withProjectLock(found.project.id, paths, async () => {
      terminateSession(sessionName(found.project));
      removeManagedBlock(found.project.id);
      delete config.projects[found.root];
      saveConfig(config, paths);
    });

    logError(
      `Removed command-proxy config for ${found.root}. No files were deleted.`,
    );
    return 0;
  }

  // Run a remote command.
  let root;
  let project;
  const existing = findProject(cwd, config);

  if (existing) {
    root = existing.root;
    project = existing.project;
    requireSsh();
    if (!parsed.noSync) {
      requireMutagen();
    }
  } else {
    assertSafeRoot(cwd);
    requireSsh();
    requireMutagen();
    if (!canPrompt()) {
      throw new CliError('first-time setup requires an interactive terminal', 70, {
        hint: 'Run command-proxy --init from a terminal, then retry the command.',
      });
    }
    root = cwd;
    project = await runWizard({ root, existing: null, config, paths });
  }

  const remoteDir = remoteDirFor(root, project, cwd);

  if (!parsed.noSync) {
    const patterns = collectIgnorePatterns(root, paths);
    await ensureSession(root, project, { paths, config, patterns });

    progress('Syncing local changes to the remote...');
    const flushed = flushSession(sessionName(project));
    if (flushed.timedOut) {
      warn(`${flushed.message}; continuing with possibly stale remote files.`);
    } else if (!flushed.ok) {
      warn(`could not flush pending changes: ${flushed.message}`);
    }
  }

  let exitCode;
  try {
    exitCode = await runRemoteCommand(project, remoteDir, parsed.command);
  } finally {
    if (!parsed.noSync) {
      try {
        progress('Syncing remote changes back...');
        const flushed = flushSession(sessionName(project));
        if (flushed.timedOut) {
          warn(`${flushed.message}; files may still be syncing in the background.`);
        } else if (!flushed.ok) {
          warn(`could not sync remote changes back: ${flushed.message}`);
        }

        const session = getSessionInfo(sessionName(project));
        if (session) {
          warnAboutConflicts(session);
        }
      } catch (err) {
        warn(`post-command sync failed: ${err.message}`);
      }
    }
  }

  if (exitCode === 255) {
    warn(
      'ssh exited with status 255. This usually means the connection failed; check your SSH alias and network.',
    );
  }
  return exitCode;
}

function printHelp() {
  console.log(`command-proxy v${pkg.version}

Run a command in the current directory on a remote server. The directory is
kept in sync in both directions with Mutagen.

Usage:
  command-proxy [options] <command> [args...]
  cmdp [options] <command> [args...]
  command-proxy --sync | --status | --init | --ignore | --reset

Options (only recognized before the command):
  --init        Reconfigure this project's SSH connection and remote directory
  --status      Show sync status and conflicts
  --sync        Sync now without running a command
  --ignore      Edit the global ignore list with $EDITOR
  --no-sync     Run the command without syncing before or after
  --reset       Stop syncing and remove this project's config (keeps all files)
  -h, --help    Show this help
  -v, --version Show the version

Everything after the command is passed to the remote server unchanged:
  command-proxy git clone --depth 1 https://example.com/repo.git
  command-proxy sh -c 'grep -r foo . | head'

Use \`command-proxy -- <command>\` if the command itself starts with a dash.

Requirements:
  Node.js >= 20.12 and an OpenSSH client.
  Mutagen 0.15 or newer is downloaded automatically by npm install when it is
  not already on PATH. SSH key login to a Linux or macOS remote host is required.

Config:
  $XDG_CONFIG_HOME/command-proxy/ or ~/.config/command-proxy/ (macOS, Linux)
  %APPDATA%\\command-proxy\\ (Windows)`);
}

try {
  const code = await main();
  process.exitCode = Number.isInteger(code) ? code : 0;
} catch (err) {
  if (err instanceof CancelledError) {
    process.exitCode = 1;
  } else if (err instanceof UsageError) {
    logError(err.message);
    logError('Run `command-proxy --help` for usage.');
    process.exitCode = err.exitCode;
  } else if (err instanceof CliError) {
    logError(err.message);
    if (err.hint) {
      logError(err.hint);
    }
    if (process.env.COMMAND_PROXY_DEBUG) {
      console.error(err.stack);
    }
    process.exitCode = err.exitCode;
  } else {
    logError(`unexpected error: ${err.message}`);
    if (process.env.COMMAND_PROXY_DEBUG) {
      console.error(err.stack);
    }
    process.exitCode = 70;
  }
}

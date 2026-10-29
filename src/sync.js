import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { canonicalPath, remoteDirFor, saveConfig } from './config.js';
import { CliError } from './errors.js';
import { hashIgnorePatterns } from './ignore.js';
import { progress, warn } from './log.js';
import { mutagenExecutable } from './mutagen.js';
import { ensureRemoteDirectory, remoteDirectoryState } from './sshconfig.js';

export { mutagenVersionTooOld } from './mutagen.js';

const LOCK_TIMEOUT_MS = 30_000;
const LOCK_STALE_MS = 5 * 60_000;

/**
 * @returns {{ available: boolean, version?: string, reason?: string }}
 */
export function checkMutagen() {
  const executable = mutagenExecutable();
  const result = spawnSync(executable, ['version'], {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
  if (result.error) {
    return {
      available: false,
      reason:
        result.error.code === 'ENOENT'
          ? 'mutagen was not found on PATH (and no bundled copy is installed)'
          : result.error.message,
    };
  }
  const output = `${result.stderr || ''}${result.stdout || ''}`.trim();
  if (result.status !== 0) {
    return {
      available: false,
      reason: output || `mutagen version exited with status ${result.status}`,
    };
  }
  return { available: true, version: output };
}

/**
 * @param {{ id: string }} project
 */
export function sessionName(project) {
  return `cp-${project.id}`;
}

/**
 * @param {{ id: string }} project
 */
export function sessionLabel(project) {
  return `command-proxy=${project.id}`;
}

function csvEscape(value) {
  if (!/[",]/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Build the Mutagen create arguments. Exported for unit tests.
 *
 * @param {string} root
 * @param {{ id: string, sshAlias: string, remoteRoot: string }} project
 * @param {string[]} patterns
 */
export function createSessionArguments(root, project, patterns) {
  const args = [
    'sync',
    'create',
    `--name=${sessionName(project)}`,
    `--label=${sessionLabel(project)}`,
    '--sync-mode=two-way-safe',
  ];
  for (const pattern of patterns) {
    args.push(`--ignore=${csvEscape(pattern)}`);
  }
  args.push(root, `${project.sshAlias}:${project.remoteRoot}`);
  return args;
}

function mutagenRun(args, { timeoutMs = 60_000, maxBuffer = 16 * 1024 * 1024 } = {}) {
  const result = spawnSync(mutagenExecutable(), args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer,
  });
  const timedOut = Boolean(
    result.error && (result.error.code === 'ETIMEDOUT' || result.signal),
  );
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
    timedOut,
  };
}

function summarizeOutput(result) {
  return [result.stderr, result.stdout]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * List all sessions, then select by name in JavaScript. Selecting inside
 * Mutagen would make "no such session" an error whose wording varies between
 * versions; a full listing is small and always valid JSON.
 *
 * @param {string} [name]
 * @returns {any[]} raw session objects from Mutagen
 */
function listSessions(name) {
  const args = ['sync', 'list', '--template', '{{json .}}'];
  if (name) {
    args.push(name);
  }

  const result = mutagenRun(args, { timeoutMs: 30_000 });
  if (!result.ok) {
    if (result.timedOut) {
      throw new CliError('timed out while asking Mutagen for sync status');
    }
    const combined = summarizeOutput(result).toLowerCase();
    if (combined.includes('unable to locate') || combined.includes('no sessions')) {
      return [];
    }
    throw new CliError(
      `mutagen sync list failed: ${summarizeOutput(result) || `exit ${result.status}`}`,
      70,
      { hint: 'Check that the Mutagen daemon is running.' },
    );
  }

  let text = (result.stdout || '').trim();
  if (text === '' || text === 'No sessions found.') {
    return [];
  }
  if (!text.startsWith('[') && !text.startsWith('{')) {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start >= 0 && end > start) {
      text = text.slice(start, end + 1);
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError(`cannot parse Mutagen's sync status output: ${text.slice(0, 500)}`);
  }
  if (parsed === null) {
    return [];
  }
  let sessions = Array.isArray(parsed) ? parsed : [parsed];
  if (name) {
    sessions = sessions.filter(
      (session) =>
        session &&
        typeof session === 'object' &&
        (session.name === name || session.identifier === name),
    );
  }
  return sessions;
}

/**
 * @param {any} session
 */
export function normalizeSession(session) {
  const paused = Boolean(session.paused);
  const status = String(session.status ?? '');
  const alpha = session.alpha && typeof session.alpha === 'object' ? session.alpha : {};
  const beta = session.beta && typeof session.beta === 'object' ? session.beta : {};
  const conflicts = Array.isArray(session.conflicts) ? session.conflicts : [];
  const excluded = Number(session.excludedConflicts ?? 0);

  return {
    name: session.name || session.identifier || '',
    identifier: session.identifier || '',
    paused,
    state: paused ? 'paused' : status || 'unknown',
    conflicts: conflicts
      .map((conflict) => {
        if (typeof conflict === 'string') {
          return conflict;
        }
        if (conflict && typeof conflict === 'object') {
          return conflict.root || conflict.path || '';
        }
        return '';
      })
      .filter(Boolean),
    excludedConflicts: Number.isFinite(excluded) && excluded > 0 ? excluded : 0,
    lastError: session.lastError || '',
    alphaPath: alpha.path || '',
    betaHost: beta.host || '',
    betaPath: beta.path || '',
  };
}

/**
 * @param {string} name
 */
export function getSessionInfo(name) {
  const sessions = listSessions(name);
  if (sessions.length === 0) {
    return null;
  }
  return normalizeSession(sessions[0]);
}

function comparableRemotePath(project, value) {
  let result = String(value);
  const prefix = `${project.sshAlias}:`;
  if (result.startsWith(prefix)) {
    result = result.slice(prefix.length);
  }
  return result.replace(/\/+$/, '');
}

/**
 * Check that an existing session points at the configured local root, SSH
 * alias, and remote root. The alias must be checked explicitly: changing it in
 * --init leaves the paths unchanged but points the session at a different
 * server.
 *
 * @param {string} root
 * @param {{ sshAlias: string, remoteRoot: string }} project
 * @param {any} session
 */
export function sessionMatchesProject(root, project, session) {
  if (session.alphaPath) {
    const alpha = canonicalPath(session.alphaPath);
    if (alpha !== canonicalPath(root)) {
      return false;
    }
  }
  if (session.betaHost && session.betaHost !== String(project.sshAlias)) {
    return false;
  }
  if (session.betaPath) {
    const beta = comparableRemotePath(project, session.betaPath);
    const expected = String(project.remoteRoot).replace(/\/+$/, '');
    if (beta !== expected) {
      return false;
    }
  }
  return true;
}

/**
 * A deleted remote root leaves the session halted. An empty recreated root is
 * treated the same way: a new session can safely upload the local files.
 *
 * @returns {'missing' | 'empty' | 'nonempty' | 'file' | 'unreadable' | 'unknown'}
 */
function remoteRootState(project) {
  try {
    return remoteDirectoryState(project.sshAlias, project.remoteRoot);
  } catch {
    return 'unknown';
  }
}

function haltedError(session) {
  return new CliError(
    `sync session "${session.name}" is halted (${session.state})` +
      (session.lastError ? `: ${session.lastError}` : ''),
    70,
    {
      hint: 'Run command-proxy --status for details. If it cannot be recovered, run command-proxy --reset and configure the project again.',
    },
  );
}

/**
 * Create the Mutagen session if needed, rebuild it when ignore rules or
 * connection settings changed, and recover from a deleted remote root.
 *
 * @param {string} root
 * @param {any} project
 * @param {{ paths: any, config: { projects: Record<string, any> }, patterns: string[], forceRebuild?: boolean }} options
 */
export async function ensureSession(root, project, options) {
  const { paths, config, patterns, forceRebuild = false } = options;
  const expectedHash = hashIgnorePatterns(patterns);

  return withProjectLock(project.id, paths, async () => {
    const name = sessionName(project);
    let session = getSessionInfo(name);

    if (session && session.paused) {
      progress(`resuming paused sync session ${name}`);
      const result = mutagenRun(['sync', 'resume', name], { timeoutMs: 30_000 });
      if (!result.ok && !result.timedOut) {
        throw new CliError(
          `could not resume sync session ${name}: ${summarizeOutput(result) || `exit ${result.status}`}`,
          70,
          { hint: 'Run command-proxy --status for details.' },
        );
      }
      session = getSessionInfo(name);
      if (!session) {
        throw new CliError(`sync session ${name} disappeared after resuming`);
      }
    }

    const hashChanged = project.ignoreHash !== expectedHash;
    const settingsChanged = session
      ? !sessionMatchesProject(root, project, session)
      : false;
    let needsRebuild = false;

    // Deal with halted sessions before considering hash/settings rebuilds:
    // rebuilding a session halted on root emptying could delete data.
    if (session && session.state.startsWith('halted')) {
      if (session.state === 'halted-on-root-deletion') {
        const state = remoteRootState(project);
        if (state === 'missing' || state === 'empty') {
          if (!existsSync(root)) {
            throw new CliError(
              'the local sync root no longer exists; refusing to rebuild the session',
              70,
              { hint: `Restore ${root} or run command-proxy --reset.` },
            );
          }
          warn(
            `remote sync directory ${project.remoteRoot} is ${state}; recreating the sync session`,
          );
          needsRebuild = true;
        } else if (state === 'file') {
          throw new CliError(
            `remote path ${project.remoteRoot} exists but is not a directory`,
            70,
            { hint: 'Choose another remote directory with command-proxy --init.' },
          );
        } else if (state === 'unreadable') {
          throw new CliError(
            `cannot read the remote sync directory ${project.remoteRoot}`,
            70,
            { hint: 'Check its permissions, or choose another directory with command-proxy --init.' },
          );
        } else {
          throw haltedError(session);
        }
      } else {
        throw haltedError(session);
      }
    }

    if (session && !needsRebuild && forceRebuild) {
      needsRebuild = true;
    }

    if (session && !needsRebuild && (hashChanged || settingsChanged)) {
      needsRebuild = true;
    }

    if (!needsRebuild) {
      if (session) {
        return;
      }
      createSession(root, project, patterns);
      project.ignoreHash = expectedHash;
      saveConfig(config, paths);
      return;
    }

    if (hashChanged) {
      progress('ignore rules changed; rebuilding the sync session');
    } else if (settingsChanged) {
      progress('connection settings changed; rebuilding the sync session');
    } else {
      progress('rebuilding the sync session');
    }
    terminateSession(name);
    createSession(root, project, patterns);
    project.ignoreHash = expectedHash;
    saveConfig(config, paths);
  });
}

/**
 * @param {string} root
 * @param {any} project
 * @param {string[]} patterns
 */
function createSession(root, project, patterns) {
  // Mutagen creates a missing synchronization root only if its parent already
  // exists, so create the full remote path first.
  ensureRemoteDirectory(project.sshAlias, project.remoteRoot);

  const args = createSessionArguments(root, project, patterns);
  let result = mutagenRun(args, { timeoutMs: 120_000 });

  // Some Mutagen versions only expose --mode. Try it if --sync-mode is
  // rejected, keeping compatibility without guessing up front.
  if (!result.ok) {
    const output = summarizeOutput(result);
    if (/sync-mode/i.test(output) && /unknown flag|not defined|invalid argument/i.test(output)) {
      const fallback = args.map((arg) =>
        arg === '--sync-mode=two-way-safe' ? '--mode=two-way-safe' : arg,
      );
      result = mutagenRun(fallback, { timeoutMs: 120_000 });
    }
  }

  if (!result.ok) {
    const reason = result.timedOut
      ? 'timed out while creating the sync session'
      : summarizeOutput(result) || `exit ${result.status}`;
    throw new CliError(`could not create the Mutagen sync session: ${reason}`, 70, {
      hint: 'Check the SSH connection and the remote directory, then retry.',
    });
  }
}

/**
 * @param {string} name
 * @returns {boolean} whether a session was terminated
 */
export function terminateSession(name) {
  const result = mutagenRun(['sync', 'terminate', name], { timeoutMs: 30_000 });
  if (result.ok) {
    return true;
  }
  if (result.timedOut) {
    throw new CliError(`timed out while terminating sync session ${name}`);
  }
  const combined = summarizeOutput(result).toLowerCase();
  if (combined.includes('unable to locate') || combined.includes('no sessions')) {
    return false;
  }
  throw new CliError(
    `could not terminate sync session ${name}: ${summarizeOutput(result) || `exit ${result.status}`}`,
    70,
    { hint: 'Run command-proxy --status, or terminate the session manually with `mutagen sync terminate`.' },
  );
}

/**
 * Flush one session. A timeout is not fatal: Mutagen keeps syncing in the
 * background and the remote command should still run.
 *
 * @param {string} name
 * @param {{ timeoutMs?: number }} [options]
 */
export function flushSession(name, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const result = mutagenRun(['sync', 'flush', name], { timeoutMs });
  if (result.ok) {
    return { ok: true, timedOut: false };
  }
  if (result.timedOut) {
    return {
      ok: false,
      timedOut: true,
      message: `sync flush timed out after ${Math.round(timeoutMs / 1000)}s`,
    };
  }
  return {
    ok: false,
    timedOut: false,
    message: summarizeOutput(result) || `exit ${result.status}`,
  };
}

export function conflictCount(session) {
  return session.conflicts.length + session.excludedConflicts;
}

/**
 * @param {any} session
 */
export function warnAboutConflicts(session) {
  const total = conflictCount(session);
  if (total === 0) {
    return;
  }
  warn(
    `${total} sync conflict${total === 1 ? '' : 's'} detected; files were not overwritten.`,
  );
  for (const conflict of session.conflicts.slice(0, 5)) {
    warn(`  ${conflict}`);
  }
  if (total > Math.min(5, session.conflicts.length)) {
    warn('  ... more conflicts are not shown; run command-proxy --status for details.');
  } else {
    warn('Run command-proxy --status for details.');
  }
}

const STATE_LABELS = {
  paused: 'paused',
  watching: 'watching for changes',
  scanning: 'scanning files',
  'waiting-for-rescan': 'waiting to rescan',
  reconciling: 'reconciling changes',
  'staging-alpha': 'staging changes locally',
  'staging-beta': 'staging changes remotely',
  transitioning: 'applying changes',
  saving: 'saving sync state',
  'connecting-alpha': 'connecting to the local endpoint',
  'connecting-beta': 'connecting to the remote endpoint',
  disconnected: 'disconnected',
  'halted-on-root-deletion': 'halted because a sync root was deleted',
  'halted-on-root-emptied': 'halted because a sync root became empty',
  'halted-on-root-type-change': 'halted because a sync root changed type',
};

/**
 * @param {string} state
 */
export function describeState(state) {
  const label = STATE_LABELS[state];
  return label ? `${label} (${state})` : state;
}

/**
 * Human-readable output for --status, written to stdout by the caller.
 *
 * @param {string} root
 * @param {any} project
 * @param {any | null} session
 * @param {{ cwd?: string }} [options]
 */
export function describeStatus(root, project, session, options = {}) {
  const lines = [
    `Project:  ${root}`,
    `Remote:   ${project.sshAlias}:${project.remoteRoot}`,
  ];

  if (options.cwd) {
    try {
      const remoteDir = remoteDirFor(root, project, options.cwd);
      if (remoteDir !== project.remoteRoot) {
        lines.push(`Here:     ${project.sshAlias}:${remoteDir}`);
      }
    } catch {
      // The cwd is outside the project; --status still shows the project.
    }
  }

  if (!session) {
    lines.push(`Session:  ${sessionName(project)} (not created yet)`);
    lines.push('Run `command-proxy --sync` to create it.');
    return lines.join('\n');
  }

  lines.push(`Session:  ${session.name || sessionName(project)}`);
  lines.push(`State:    ${describeState(session.state)}`);

  const total = conflictCount(session);
  lines.push(`Conflicts: ${total}`);
  const shown = session.conflicts.slice(0, 20);
  for (const conflict of shown) {
    lines.push(`  - ${conflict}`);
  }
  const hidden = total - shown.length;
  if (hidden > 0) {
    lines.push(`  ... and ${hidden} more`);
  }
  if (session.lastError) {
    lines.push(`Last error: ${session.lastError}`);
  }
  return lines.join('\n');
}

/**
 * Serialize session creation/rebuild across concurrent command-proxy runs.
 * Stale locks are removed after five minutes.
 *
 * @template T
 * @param {string} id
 * @param {{ locksDir: string }} paths
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withProjectLock(id, paths, fn) {
  mkdirSync(paths.locksDir, { recursive: true });
  const lockPath = path.join(paths.locksDir, `${id}.lock`);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      writeSync(fd, token);
      closeSync(fd);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw new CliError(`cannot create lock file ${lockPath}: ${err.message}`);
      }
      try {
        const info = statSync(lockPath);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        // The other process may have just released the lock; retry.
      }
      if (Date.now() >= deadline) {
        throw new CliError(
          `another command-proxy process is configuring this project (lock: ${lockPath})`,
          70,
          {
            hint: 'Wait for it to finish. If no other process is running, delete the lock file and retry.',
          },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  try {
    return await fn();
  } finally {
    try {
      if (readFileSync(lockPath, 'utf8') === token) {
        rmSync(lockPath, { force: true });
      }
    } catch {
      // The lock is already gone or unreadable; nothing useful to do.
    }
  }
}

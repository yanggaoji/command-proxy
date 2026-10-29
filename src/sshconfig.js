import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliError } from './errors.js';
import { shQuote } from './run.js';

const REMOTE_SYSTEM_ROOTS = new Set([
  '/',
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/home',
  '/lib',
  '/lib64',
  '/opt',
  '/proc',
  '/root',
  '/sbin',
  '/sys',
  '/tmp',
  '/usr',
  '/var',
  '/Users',
  '/System',
  '/Applications',
  '/Library',
  '/private',
  '/private/etc',
  '/private/tmp',
  '/private/var',
]);

export function getSshConfigPath() {
  return path.join(os.homedir(), '.ssh', 'config');
}

/**
 * @returns {{ available: boolean, version?: string, reason?: string }}
 */
export function checkSshClient() {
  const result = spawnSync('ssh', ['-V'], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.error) {
    return {
      available: false,
      reason: result.error.code === 'ENOENT' ? 'ssh was not found on PATH' : result.error.message,
    };
  }
  return {
    available: true,
    version: `${result.stderr || ''}${result.stdout || ''}`.trim(),
  };
}

/**
 * @param {string} alias
 */
export function isValidAlias(alias) {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(alias);
}

/**
 * @param {string} user
 */
function isValidUsername(user) {
  return /^[A-Za-z0-9._][A-Za-z0-9._-]*$/.test(user);
}

/**
 * @param {string} hostname
 */
function isValidHostname(hostname) {
  return /^[A-Za-z0-9._:%-]+$/.test(hostname) && !hostname.startsWith('-');
}

/**
 * Parse the user@host[:port] form. Returns null for anything else.
 *
 * @param {string} value
 * @returns {{ user: string, hostname: string, port: number } | null}
 */
export function parseSshDestination(value) {
  const match = /^([^@\s]+)@(\[[^\]\s]+\]|[^:\s]+)(?::(\d{1,5}))?$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const user = match[1];
  let hostname = match[2];
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }
  if (!isValidUsername(user) || !isValidHostname(hostname)) {
    return null;
  }
  const port = match[3] ? Number(match[3]) : 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  return { user, hostname, port };
}

/**
 * @param {string} value
 * @returns {number | null}
 */
export function normalizePort(value) {
  const port = Number(String(value).trim());
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/**
 * Expand a leading ~ for command-line arguments. ssh itself expands ~ in the
 * config file, but not when a path is passed with -i.
 *
 * @param {string} value
 */
export function expandHome(value) {
  if (value === '~') {
    return os.homedir();
  }
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

/**
 * Normalize a key path for an SSH config file. Backslashes are converted on
 * Windows because OpenSSH treats them as escapes in config values.
 *
 * @param {string} value
 */
function normalizeIdentityFile(value) {
  let result = value;
  if (
    (result.startsWith('"') && result.endsWith('"')) ||
    (result.startsWith("'") && result.endsWith("'"))
  ) {
    result = result.slice(1, -1);
  }
  return process.platform === 'win32' ? result.replace(/\\/g, '/') : result;
}

/**
 * @param {string} name
 * @param {string} value
 */
function assertSingleLine(name, value) {
  if (/[\r\n\0]/.test(String(value))) {
    throw new CliError(`invalid ${name} for the SSH config`);
  }
}

/**
 * @param {string} value
 */
function quoteConfigValue(value) {
  if (!/[\s"'\\#]/.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * @param {string} stdout
 * @returns {Record<string, string>}
 */
export function parseSshGOutput(stdout) {
  const result = {};
  for (const line of stdout.split(/\r?\n/)) {
    if (!line || line.startsWith(' ')) {
      continue;
    }
    const index = line.indexOf(' ');
    if (index <= 0) {
      continue;
    }
    const key = line.slice(0, index).toLowerCase();
    const value = line.slice(index + 1).trim();
    if (!(key in result)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * @param {string} alias
 */
export function readResolvedSshConfig(alias) {
  const result = spawnSync('ssh', ['-G', alias], {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
  if (result.error) {
    throw new CliError(`cannot read the SSH configuration for "${alias}": ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new CliError(
      `ssh -G ${alias} failed: ${(result.stderr || '').trim() || `exit ${result.status}`}`,
    );
  }
  return parseSshGOutput(result.stdout || '');
}

/**
 * Build the marked block appended to ~/.ssh/config for a managed connection.
 *
 * @param {string} id
 * @param {{
 *   alias: string,
 *   hostname: string,
 *   user: string,
 *   port: number,
 *   identityFile?: string,
 *   platform?: NodeJS.Platform,
 * }} options
 */
export function buildManagedBlock(id, options) {
  if (!/^[A-Za-z0-9]+$/.test(id)) {
    throw new CliError('invalid project id for the SSH config block');
  }
  if (!isValidAlias(options.alias)) {
    throw new CliError(`invalid SSH alias: ${options.alias}`);
  }
  if (!isValidHostname(options.hostname)) {
    throw new CliError(`invalid SSH host name: ${options.hostname}`);
  }
  if (!isValidUsername(options.user)) {
    throw new CliError(`invalid SSH user: ${options.user}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new CliError(`invalid SSH port: ${options.port}`);
  }
  assertSingleLine('host name', options.hostname);
  assertSingleLine('user', options.user);

  const lines = [
    `# >>> command-proxy:${id} >>>`,
    `Host ${options.alias}`,
    `  HostName ${options.hostname}`,
    `  User ${options.user}`,
    `  Port ${options.port}`,
  ];

  if (options.identityFile) {
    assertSingleLine('identity file', options.identityFile);
    lines.push(`  IdentityFile ${quoteConfigValue(normalizeIdentityFile(options.identityFile))}`);
  }

  lines.push('  ServerAliveInterval 30');

  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    lines.push(
      '  ControlMaster auto',
      '  ControlPath ~/.ssh/cm-%C',
      '  ControlPersist 10m',
    );
  }

  lines.push(`# <<< command-proxy:${id} <<<`);
  return lines.join('\n');
}

export function managedMarkers(id) {
  return {
    start: `# >>> command-proxy:${id} >>>`,
    end: `# <<< command-proxy:${id} <<<`,
  };
}

/**
 * Remove this project's managed block from a config file's text. If a start
 * marker exists without an end marker, nothing is changed and an error is
 * thrown, so a damaged file is never rewritten.
 *
 * @param {string} text
 * @param {string} id
 * @returns {{ text: string, removed: boolean }}
 */
export function stripManagedBlock(text, id) {
  const { start, end } = managedMarkers(id);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const kept = [];
  let found = false;
  let inBlock = false;

  for (const line of lines) {
    if (!inBlock && line.trim() === start) {
      inBlock = true;
      found = true;
      continue;
    }
    if (inBlock) {
      if (line.trim() === end) {
        inBlock = false;
      }
      continue;
    }
    kept.push(line);
  }

  if (inBlock) {
    throw new CliError(
      'the command-proxy block in ~/.ssh/config is incomplete (the end marker is missing)',
      70,
      { hint: 'Fix or remove that block manually, then try again.' },
    );
  }
  if (!found) {
    return { text, removed: false };
  }

  while (kept.length > 0 && kept[kept.length - 1].trim() === '') {
    kept.pop();
  }
  const result = kept.length > 0 ? `${kept.join(eol)}${eol}` : '';
  return { text: result, removed: true };
}

/**
 * @param {string} file
 * @param {string} content
 * @param {number} mode
 */
function writeFileAtomic(file, content, mode) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, content, { mode });
    renameSync(temp, file);
  } catch (err) {
    rmSync(temp, { force: true });
    throw new CliError(`cannot write ${file}: ${err.message}`);
  }
}

/**
 * Append or replace the managed block for this project. User content is never
 * touched. The original file is copied to <config>.bak first.
 *
 * @param {string} id
 * @param {string} block
 * @param {{ configPath?: string, backup?: boolean }} [options]
 */
export function upsertManagedBlock(id, block, options = {}) {
  const configPath = options.configPath ?? getSshConfigPath();
  const backup = options.backup ?? true;
  const existed = existsSync(configPath);

  let current = '';
  if (existed) {
    try {
      current = readFileSync(configPath, 'utf8');
    } catch (err) {
      throw new CliError(`cannot read ${configPath}: ${err.message}`);
    }
  }

  const eol = current.includes('\r\n')
    ? '\r\n'
    : current === '' && process.platform === 'win32'
      ? '\r\n'
      : '\n';
  const managedBlock = eol === '\n' ? block : block.replace(/\n/g, eol);
  const stripped = stripManagedBlock(current, id);
  const withoutBlock = stripped.text;

  let result;
  if (withoutBlock.trim() === '') {
    result = `${managedBlock}${eol}`;
  } else {
    result = withoutBlock;
    if (!/\r?\n$/.test(result)) {
      result += eol;
    }
    result += `${eol}${managedBlock}${eol}`;
  }

  let backupPath;
  if (existed && backup) {
    backupPath = `${configPath}.bak`;
    try {
      copyFileSync(configPath, backupPath);
    } catch (err) {
      throw new CliError(`cannot back up ${configPath}: ${err.message}`);
    }
  }

  const mode = existed ? statSync(configPath).mode & 0o777 : 0o600;
  writeFileAtomic(configPath, result, mode);
  return { removed: stripped.removed, backupPath };
}

/**
 * @param {string} id
 * @param {{ configPath?: string, backup?: boolean }} [options]
 * @returns {{ removed: boolean, backupPath?: string }}
 */
export function removeManagedBlock(id, options = {}) {
  const configPath = options.configPath ?? getSshConfigPath();
  const backup = options.backup ?? true;
  if (!existsSync(configPath)) {
    return { removed: false };
  }

  let current;
  try {
    current = readFileSync(configPath, 'utf8');
  } catch (err) {
    throw new CliError(`cannot read ${configPath}: ${err.message}`);
  }

  const stripped = stripManagedBlock(current, id);
  if (!stripped.removed) {
    return { removed: false };
  }

  let backupPath;
  if (backup) {
    backupPath = `${configPath}.bak`;
    try {
      copyFileSync(configPath, backupPath);
    } catch (err) {
      throw new CliError(`cannot back up ${configPath}: ${err.message}`);
    }
  }

  const mode = statSync(configPath).mode & 0o777;
  writeFileAtomic(configPath, stripped.text, mode);
  return { removed: true, backupPath };
}

/**
 * Run a non-interactive ssh command and capture its output.
 *
 * @param {string | { hostname: string, user?: string, port?: number, identityFile?: string }} target
 * @param {string} remoteCommand
 * @param {{ timeoutMs?: number }} [options]
 */
export function testSshConnection(target, remoteCommand = 'true', options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];

  if (typeof target === 'string') {
    args.push(target);
  } else {
    if (target.port) {
      args.push('-p', String(target.port));
    }
    if (target.identityFile) {
      const identityFile = expandHome(target.identityFile);
      args.push('-i', identityFile);
    }
    if (target.user) {
      args.push('-l', target.user);
    }
    args.push(target.hostname);
  }
  // Run probes through /bin/sh so they work even when the remote account's
  // login shell is not Bourne-compatible (for example csh).
  args.push(`sh -c ${shQuote(remoteCommand)}`);

  const result = spawnSync('ssh', args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
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

/**
 * Connect and read the remote home directory. Used by the wizard, which wants
 * to retry rather than throw on the first failure.
 *
 * @param {string | { hostname: string, user?: string, port?: number, identityFile?: string }} target
 */
export function readRemoteHome(target) {
  const result = testSshConnection(target, 'printf %s "$HOME"');
  if (!result.ok) {
    return { ...result, home: null };
  }
  const home = result.stdout.trim();
  if (!home || !home.startsWith('/')) {
    return {
      ...result,
      ok: false,
      home: null,
      stderr: result.stderr || `unexpected remote home directory: "${home}"`,
    };
  }
  return { ...result, home };
}

/**
 * @param {string | { hostname: string, user?: string, port?: number, identityFile?: string }} target
 * @param {string} remoteDir
 * @returns {'missing' | 'empty' | 'nonempty' | 'file' | 'unreadable'}
 */
export function remoteDirectoryState(target, remoteDir) {
  const quoted = shQuote(remoteDir);
  const remoteCommand =
    `if [ -d ${quoted} ]; then ` +
    `if [ ! -r ${quoted} ] || [ ! -x ${quoted} ]; then printf unreadable; ` +
    `elif [ -n "$(ls -A ${quoted} 2>/dev/null | head -n 1)" ]; then printf nonempty; else printf empty; fi; ` +
    `elif [ -e ${quoted} ]; then printf file; else printf missing; fi`;
  const result = testSshConnection(target, remoteCommand);
  if (!result.ok) {
    const reason = result.stderr.trim() || result.error?.message || `ssh exit ${result.status}`;
    throw new CliError(`cannot inspect remote directory ${remoteDir}: ${reason}`, 70, {
      hint: 'Check the SSH connection and permissions on the remote directory.',
    });
  }
  const state = result.stdout.trim();
  if (!['missing', 'empty', 'nonempty', 'file', 'unreadable'].includes(state)) {
    throw new CliError(`unexpected response while checking ${remoteDir}: "${state}"`);
  }
  return state;
}

/**
 * Create the remote synchronization root (and its parents) if needed, and
 * verify that the remote user can write to it. Mutagen requires the root's
 * parent to exist; it will create the root itself, but not the parent chain.
 *
 * @param {string | { hostname: string, user?: string, port?: number, identityFile?: string }} target
 * @param {string} remoteDir
 */
export function ensureRemoteDirectory(target, remoteDir) {
  const quoted = shQuote(remoteDir);
  const result = testSshConnection(target, `mkdir -p ${quoted} && test -w ${quoted}`);
  if (!result.ok) {
    const reason = result.stderr.trim() || result.error?.message || `ssh exit ${result.status}`;
    throw new CliError(
      `cannot create or write the remote directory ${remoteDir}: ${reason}`,
      70,
      {
        hint: 'Check permissions on the remote server, or choose another directory with command-proxy --init.',
      },
    );
  }
}

/**
 * Resolve a user-entered remote directory against the remote home directory.
 *
 * @param {string} home
 * @param {string} input
 */
export function resolveRemoteRoot(home, input) {
  const value = String(input).trim();
  let resolved;
  if (value === '~') {
    resolved = home;
  } else if (value.startsWith('~/')) {
    resolved = path.posix.join(home, value.slice(2));
  } else if (value.startsWith('/')) {
    resolved = value;
  } else {
    resolved = path.posix.join(home, value);
  }
  resolved = path.posix.normalize(resolved);
  if (resolved.length > 1) {
    resolved = resolved.replace(/\/+$/, '');
  }
  return resolved;
}

/**
 * @param {string} home
 * @param {string} resolved
 * @returns {string | null}
 */
export function remoteRootProblem(home, resolved) {
  if (resolved === '/') {
    return 'the remote directory cannot be /';
  }
  if (path.posix.normalize(home) === resolved) {
    return 'the remote directory cannot be the remote home directory';
  }
  if (REMOTE_SYSTEM_ROOTS.has(resolved)) {
    return 'the remote directory cannot be a system directory';
  }
  return null;
}

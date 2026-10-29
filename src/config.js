import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliError } from './errors.js';

const SYSTEM_ROOTS_POSIX = [
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
];

/**
 * Resolve a path to its real form without requiring the path to exist.
 * Windows extended-length prefixes are removed so paths are comparable and
 * usable as Mutagen endpoints.
 *
 * @param {string} value
 */
export function realPath(value) {
  let resolved;
  try {
    resolved = realpathSync.native(value);
  } catch {
    resolved = path.resolve(value);
  }
  if (resolved.startsWith('\\\\?\\UNC\\')) {
    return `\\\\${resolved.slice(8)}`;
  }
  if (resolved.startsWith('\\\\?\\')) {
    return resolved.slice(4);
  }
  return resolved;
}

/**
 * A comparison key for paths. Windows is case-insensitive, so keys are
 * lower-cased there.
 *
 * @param {string} value
 */
export function canonicalPath(value) {
  const resolved = realPath(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Global state lives outside projects:
 *   ~/.config/command-proxy/            (macOS, Linux)
 *   %APPDATA%/command-proxy/            (Windows)
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 */
export function getPaths(env = process.env, platform = process.platform) {
  let dir;
  if (platform === 'win32') {
    const appData = env.APPDATA;
    dir = appData
      ? path.join(appData, 'command-proxy')
      : path.join(os.homedir(), 'AppData', 'Roaming', 'command-proxy');
  } else {
    const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    dir = path.join(base, 'command-proxy');
  }
  return pathsFor(dir);
}

/**
 * Build the global paths from a directory. Exported so tests can use a
 * temporary directory without touching the user's real config.
 *
 * @param {string} dir
 */
export function pathsFor(dir) {
  return {
    dir,
    configPath: path.join(dir, 'config.json'),
    ignorePath: path.join(dir, 'ignore'),
    locksDir: path.join(dir, 'locks'),
  };
}

/**
 * @param {{ configPath: string }} paths
 * @returns {{ projects: Record<string, any> }}
 */
export function loadConfig(paths) {
  if (!existsSync(paths.configPath)) {
    return { projects: {} };
  }

  let text;
  try {
    text = readFileSync(paths.configPath, 'utf8');
  } catch (err) {
    throw new CliError(`cannot read config file ${paths.configPath}: ${err.message}`);
  }
  if (text.trim() === '') {
    return { projects: {} };
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new CliError(`config file is not valid JSON: ${paths.configPath}`, 70, {
      hint: 'Fix or delete the file, then run command-proxy --init.',
    });
  }

  if (
    !data ||
    typeof data !== 'object' ||
    !data.projects ||
    typeof data.projects !== 'object' ||
    Array.isArray(data.projects)
  ) {
    throw new CliError(`config file has an unexpected shape: ${paths.configPath}`, 70, {
      hint: 'Delete the file and run command-proxy --init to recreate it.',
    });
  }

  for (const [root, project] of Object.entries(data.projects)) {
    if (
      !project ||
      typeof project !== 'object' ||
      typeof project.id !== 'string' ||
      typeof project.sshAlias !== 'string' ||
      typeof project.remoteRoot !== 'string'
    ) {
      throw new CliError(`config entry for "${root}" is invalid: ${paths.configPath}`, 70, {
        hint: 'Delete the file and run command-proxy --init to recreate it.',
      });
    }
    if (project.shellMode !== 'plain') {
      project.shellMode = 'login';
    }
    if (project.ignoreHash !== undefined && typeof project.ignoreHash !== 'string') {
      delete project.ignoreHash;
    }
    // The alias is passed to ssh as a positional argument. Refuse values that
    // would be parsed as options or that ssh could not use as a destination.
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(project.sshAlias)) {
      throw new CliError(`config entry for "${root}" has an invalid SSH alias: ${project.sshAlias}`, 70, {
        hint: 'Fix the sshAlias value in config.json, or delete that entry and run command-proxy --init.',
      });
    }
    if (
      !project.remoteRoot.startsWith('/') ||
      path.posix.normalize(project.remoteRoot) === '/'
    ) {
      throw new CliError(`config entry for "${root}" has an invalid remoteRoot: ${project.remoteRoot}`, 70, {
        hint: 'Fix the remoteRoot value in config.json, or delete that entry and run command-proxy --init.',
      });
    }
  }

  return data;
}

/**
 * @param {{ projects: Record<string, any> }} config
 * @param {{ dir: string, configPath: string }} paths
 */
export function saveConfig(config, paths) {
  mkdirSync(paths.dir, { recursive: true });
  const temp = `${paths.configPath}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, paths.configPath);
  } catch (err) {
    rmSync(temp, { force: true });
    throw new CliError(`cannot write config file ${paths.configPath}: ${err.message}`);
  }
}

/**
 * Find the nearest registered project at or above `cwd`, like git finds .git.
 *
 * @param {string} cwd
 * @param {{ projects: Record<string, any> }} config
 * @returns {{ root: string, project: any } | null}
 */
export function findProject(cwd, config) {
  const entries = Object.entries(config.projects).map(([root, project]) => ({
    root,
    project,
    key: canonicalPath(root),
  }));
  if (entries.length === 0) {
    return null;
  }

  let dir = canonicalPath(cwd);
  while (true) {
    const found = entries.find((entry) => entry.key === dir);
    if (found) {
      return { root: found.root, project: found.project };
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/**
 * Map a local directory inside the project to its remote counterpart.
 *
 * @param {string} root
 * @param {{ remoteRoot: string }} project
 * @param {string} cwd
 */
export function remoteDirFor(root, project, cwd) {
  const relativeNative = path.relative(realPath(root), realPath(cwd));
  if (relativeNative === '') {
    return project.remoteRoot;
  }
  if (
    relativeNative === '..' ||
    relativeNative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeNative)
  ) {
    throw new CliError(`current directory is outside the project root: ${cwd}`);
  }
  const relative = relativeNative.split(path.sep).join('/');
  return path.posix.join(project.remoteRoot, relative);
}

/**
 * Refuse to register a home directory, filesystem root, or system directory as
 * a project. Returns a human-readable reason, or null when the path is safe.
 *
 * @param {string} value
 * @param {NodeJS.ProcessEnv} [env]
 */
export function unsafeProjectRootReason(value, env = process.env) {
  const resolved = canonicalPath(value);
  const home = canonicalPath(os.homedir());

  if (resolved === home) {
    return 'it is your home directory';
  }

  const filesystemRoot = canonicalPath(path.parse(resolved).root);
  if (resolved === filesystemRoot || `${resolved}${path.sep}` === filesystemRoot) {
    return 'it is a filesystem root';
  }

  const blocked = new Set();
  if (process.platform === 'win32') {
    for (const name of ['SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']) {
      if (env[name]) {
        blocked.add(canonicalPath(env[name]));
      }
    }
    blocked.add(canonicalPath(path.join(filesystemRoot, 'Users')));
  } else {
    for (const root of SYSTEM_ROOTS_POSIX) {
      blocked.add(canonicalPath(root));
    }
  }

  if (blocked.has(resolved)) {
    return 'it is a system directory';
  }
  return null;
}

/**
 * A stable, short id for a project. Extends the hash if the first characters
 * collide with another registered project.
 *
 * @param {string} root
 * @param {Record<string, any>} projects
 * @param {string} [existingId]
 */
export function allocateProjectId(root, projects, existingId) {
  if (existingId) {
    return existingId;
  }
  const digest = createHash('sha256').update(canonicalPath(root)).digest('hex');
  const used = new Set(
    Object.values(projects)
      .map((project) => project && project.id)
      .filter(Boolean),
  );
  for (let length = 6; length <= 12; length += 2) {
    const candidate = digest.slice(0, length);
    if (!used.has(candidate)) {
      return candidate;
    }
  }
  return digest.slice(0, 16);
}

/**
 * A short, filesystem- and Mutagen-friendly name for the project directory.
 *
 * @param {string} root
 */
export function projectSlug(root) {
  const base = path.basename(realPath(root));
  let slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  slug = slug.slice(0, 30).replace(/-+$/g, '');
  return slug || 'project';
}

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CliError } from './errors.js';

/** Conservative defaults: things almost nobody wants to sync. */
export const DEFAULT_IGNORES = [
  'node_modules',
  '.DS_Store',
  'Thumbs.db',
  '__pycache__',
  '*.pyc',
  '.venv',
  '.cache',
];

/** Optional per-project ignore file, meant to be committed with the project. */
export const PROJECT_IGNORE_FILE = '.command-proxyignore';

const GLOBAL_IGNORE_HEADER = `# command-proxy global ignore list
# Same syntax as .gitignore. One pattern per line; lines starting with # are comments.
#
# Built-in defaults (always applied before this file):
#   ${DEFAULT_IGNORES.join(', ')}
#
# Project-specific patterns can be added to ${PROJECT_IGNORE_FILE} in the project root.
#
# Examples:
#   dist
#   *.log
#   !important.log
`;

/**
 * Create the global ignore file with a commented header if it does not exist.
 *
 * @param {{ dir: string, ignorePath: string }} paths
 */
export function ensureGlobalIgnoreFile(paths) {
  if (existsSync(paths.ignorePath)) {
    return;
  }
  try {
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.ignorePath, GLOBAL_IGNORE_HEADER, { mode: 0o600 });
  } catch (err) {
    throw new CliError(`cannot create ignore file ${paths.ignorePath}: ${err.message}`);
  }
}

/**
 * @param {string} file
 * @returns {string[]}
 */
function readIgnoreFile(file) {
  if (!file || !existsSync(file)) {
    return [];
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new CliError(`cannot read ignore file ${file}: ${err.message}`);
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/**
 * Merge the three ignore layers, in order:
 *   built-in defaults -> global ignore file -> project .command-proxyignore
 *
 * @param {string} projectRoot
 * @param {{ ignorePath: string }} paths
 */
export function collectIgnorePatterns(projectRoot, paths) {
  return [
    ...DEFAULT_IGNORES,
    ...readIgnoreFile(paths.ignorePath),
    ...readIgnoreFile(path.join(projectRoot, PROJECT_IGNORE_FILE)),
  ];
}

/**
 * @param {string[]} patterns
 */
export function hashIgnorePatterns(patterns) {
  return createHash('sha256').update(`${patterns.join('\n')}\n`).digest('hex');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert the subset of .gitignore/doublestar glob syntax used by ignore
 * patterns into a regular expression. `**` crosses path separators, `*` and
 * `?` do not.
 *
 * @param {string} pattern
 */
function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        i += 1;
        if (pattern[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if (char === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) {
        out += '\\[';
      } else {
        let content = pattern.slice(i + 1, end);
        if (content.startsWith('!')) {
          content = `^${content.slice(1)}`;
        } else if (content.startsWith('^')) {
          content = `\\^${content.slice(1)}`;
        }
        content = content.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
        out += `[${content}]`;
        i = end;
      }
    } else {
      out += escapeRegExp(char);
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * @param {string} source
 */
function parseRule(source) {
  let pattern = source;
  let negate = false;
  if (pattern.startsWith('!')) {
    negate = true;
    pattern = pattern.slice(1);
  }
  let dirOnly = false;
  if (pattern.endsWith('/')) {
    dirOnly = true;
    pattern = pattern.slice(0, -1);
  }
  let anchored = false;
  if (pattern.startsWith('/')) {
    anchored = true;
    pattern = pattern.slice(1);
  }
  if (pattern === '') {
    return null;
  }
  return {
    negate,
    dirOnly,
    anchored,
    hasSlash: pattern.includes('/'),
    regex: globToRegExp(pattern),
  };
}

/**
 * Build a matcher for the pre-sync directory scan. This is an approximation of
 * Mutagen's ignore semantics, used only to decide whether the directory is so
 * large that the user should confirm before syncing.
 *
 * @param {string[]} patterns
 * @returns {(relativePath: string, isDirectory?: boolean) => boolean}
 */
export function createIgnoreMatcher(patterns) {
  const rules = patterns.map(parseRule).filter(Boolean);

  return (relativePath, isDirectory = false) => {
    const rel = String(relativePath)
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .replace(/\/+$/, '');
    if (rel === '') {
      return false;
    }

    const parts = rel.split('/');
    const candidates = [];
    for (let i = 1; i <= parts.length; i += 1) {
      candidates.push({
        path: parts.slice(0, i).join('/'),
        isDir: i < parts.length || isDirectory,
      });
    }

    let ignored = false;
    for (const rule of rules) {
      let matched = false;
      if (!rule.hasSlash) {
        if (rule.anchored) {
          matched = rule.dirOnly
            ? candidates[0].isDir && rule.regex.test(parts[0])
            : rule.regex.test(parts[0]);
        } else if (rule.dirOnly) {
          const directories = isDirectory ? candidates : candidates.slice(0, -1);
          matched = directories.some(
            (candidate) => candidate.isDir && rule.regex.test(candidate.path.split('/').pop()),
          );
        } else {
          matched = parts.some((part) => rule.regex.test(part));
        }
      } else {
        matched = candidates.some(
          (candidate) =>
            (!rule.dirOnly || candidate.isDir) && rule.regex.test(candidate.path),
        );
      }
      if (matched) {
        ignored = !rule.negate;
      }
    }
    return ignored;
  };
}

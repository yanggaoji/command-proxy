import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_IGNORES,
  collectIgnorePatterns,
  createIgnoreMatcher,
  ensureGlobalIgnoreFile,
  hashIgnorePatterns,
} from '../src/ignore.js';
import { pathsFor, realPath } from '../src/config.js';

function tempDir(t) {
  const dir = realPath(mkdtempSync(path.join(os.tmpdir(), 'command-proxy-ignore-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('merges the three ignore layers in order', (t) => {
  const root = tempDir(t);
  const paths = pathsFor(path.join(root, 'state'));
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.ignorePath, '# comment\n\ndist\n*.log\n');
  writeFileSync(path.join(root, '.command-proxyignore'), 'custom\n# another comment\n');

  assert.deepEqual(collectIgnorePatterns(root, paths), [
    ...DEFAULT_IGNORES,
    'dist',
    '*.log',
    'custom',
  ]);
});

test('missing ignore files contribute nothing', (t) => {
  const root = tempDir(t);
  const paths = pathsFor(path.join(root, 'state'));
  assert.deepEqual(collectIgnorePatterns(root, paths), [...DEFAULT_IGNORES]);
});

test('hashes patterns deterministically and order-sensitively', () => {
  assert.equal(hashIgnorePatterns(['a', 'b']), hashIgnorePatterns(['a', 'b']));
  assert.notEqual(hashIgnorePatterns(['a', 'b']), hashIgnorePatterns(['b', 'a']));
});

test('creates the global ignore file without overwriting it', (t) => {
  const root = tempDir(t);
  const paths = pathsFor(path.join(root, 'state'));
  ensureGlobalIgnoreFile(paths);
  const initial = readFileSync(paths.ignorePath, 'utf8');
  assert.match(initial, /command-proxy global ignore list/);

  writeFileSync(paths.ignorePath, `${initial}\nmy-pattern\n`);
  ensureGlobalIgnoreFile(paths);
  assert.match(readFileSync(paths.ignorePath, 'utf8'), /my-pattern/);
});

test('matches leaf-name patterns at any depth', () => {
  const ignored = createIgnoreMatcher(['node_modules', '*.pyc']);
  assert.equal(ignored('node_modules/x.js', false), true);
  assert.equal(ignored('src/node_modules/x.js', false), true);
  assert.equal(ignored('src/a.pyc', false), true);
  assert.equal(ignored('src/a.js', false), false);
});

test('matches anchored patterns only at the root', () => {
  const ignored = createIgnoreMatcher(['/build', '/config/*.json']);
  assert.equal(ignored('build', true), true);
  assert.equal(ignored('build/out.js', false), true);
  assert.equal(ignored('src/build', true), false);
  assert.equal(ignored('config/a.json', false), true);
  assert.equal(ignored('src/config/a.json', false), false);
});

test('handles directory-only patterns', () => {
  const ignored = createIgnoreMatcher(['cache/', 'logs/**/tmp/']);
  assert.equal(ignored('cache', true), true);
  assert.equal(ignored('cache/file', false), true);
  assert.equal(ignored('cache', false), false);
  assert.equal(ignored('src/cache/file', false), true);
  assert.equal(ignored('logs/a/b/tmp/file', false), true);
});

test('supports negation with last-match-wins', () => {
  const ignored = createIgnoreMatcher(['*.log', '!important.log']);
  assert.equal(ignored('a.log', false), true);
  assert.equal(ignored('important.log', false), false);
  assert.equal(ignored('logs/important.log', false), false);
});

test('supports ** and ? in patterns', () => {
  const ignored = createIgnoreMatcher(['**/tmp', 'src/?.js', '[Bb]uild']);
  assert.equal(ignored('a/tmp/file', false), true);
  assert.equal(ignored('tmp/file', false), true);
  assert.equal(ignored('src/a.js', false), true);
  assert.equal(ignored('src/ab.js', false), false);
  assert.equal(ignored('Build/out', false), true);
  assert.equal(ignored('build/out', false), true);
  assert.equal(ignored('xbuild/out', false), false);
});

test('normalizes Windows separators', () => {
  const ignored = createIgnoreMatcher(['node_modules']);
  assert.equal(ignored('src\\node_modules\\x.js', false), true);
});

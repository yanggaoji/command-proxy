import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { realPath } from '../src/config.js';
import { DEFAULT_IGNORES } from '../src/ignore.js';
import { scanDirectory } from '../src/wizard.js';

function tempDir(t) {
  const dir = realPath(mkdtempSync(path.join(os.tmpdir(), 'command-proxy-scan-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('scans files while applying ignore rules', (t) => {
  const root = tempDir(t);
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  mkdirSync(path.join(root, 'dist'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'a.js'), 'hello');
  writeFileSync(path.join(root, 'node_modules', 'dep.js'), 'ignored');
  writeFileSync(path.join(root, 'dist', 'out.js'), 'ignored');
  writeFileSync(path.join(root, '.command-proxyignore'), 'dist');

  const scan = scanDirectory(root, [...DEFAULT_IGNORES, 'dist']);
  assert.equal(scan.files, 2);
  assert.ok(scan.bytes > 0);
  assert.equal(scan.limitExceeded, false);
});

test('stops early when a limit is exceeded', (t) => {
  const root = tempDir(t);
  writeFileSync(path.join(root, 'a.txt'), 'a');
  writeFileSync(path.join(root, 'b.txt'), 'b');

  const scan = scanDirectory(root, [], { maxFiles: 0 });
  assert.equal(scan.limitExceeded, true);
  assert.equal(scan.files, 1);

  const sizeScan = scanDirectory(root, [], { maxBytes: 0 });
  assert.equal(sizeScan.limitExceeded, true);
});

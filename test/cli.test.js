import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/command-proxy.js', import.meta.url));
const node = process.execPath;

test('--version prints only the version to stdout', () => {
  const result = spawnSync(node, [bin, '--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
  assert.equal(result.stderr, '');
});

test('--help prints usage to stdout', () => {
  const result = spawnSync(node, [bin, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /--no-sync/);
  assert.match(result.stdout, /--reset/);
  assert.equal(result.stderr, '');
});

test('no arguments prints help', () => {
  const result = spawnSync(node, [bin], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
});

test('unknown options exit with 2 and write to stderr', () => {
  const result = spawnSync(node, [bin, '--bogus'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown option/);
  assert.equal(result.stdout, '');
});

test('a management option with a command exits with 2', () => {
  const result = spawnSync(node, [bin, '--status', 'git', 'status'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /does not take a command/);
  assert.equal(result.stdout, '');
});

test('--status without a project exits with 70 and writes to stderr', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'command-proxy-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const result = spawnSync(node, [bin, '--status'], {
    encoding: 'utf8',
    cwd: dir,
    env: {
      ...process.env,
      APPDATA: dir,
      HOME: dir,
      USERPROFILE: dir,
      XDG_CONFIG_HOME: dir,
    },
  });

  assert.equal(result.status, 70);
  assert.match(result.stderr, /no command-proxy project/);
  assert.equal(result.stdout, '');
});

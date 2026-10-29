import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArgv } from '../src/args.js';
import { UsageError } from '../src/errors.js';

test('parses a remote command with its own options', () => {
  assert.deepEqual(parseArgv(['git', 'clone', '--depth', '1', 'url']), {
    action: 'run',
    command: ['git', 'clone', '--depth', '1', 'url'],
    noSync: false,
  });
});

test('options are only parsed before the command', () => {
  assert.deepEqual(parseArgv(['echo', '--no-sync', '--help']), {
    action: 'run',
    command: ['echo', '--no-sync', '--help'],
    noSync: false,
  });
});

test('parses --no-sync before a command', () => {
  assert.deepEqual(parseArgv(['--no-sync', 'echo', 'hi']), {
    action: 'run',
    command: ['echo', 'hi'],
    noSync: true,
  });
});

test('-- stops option parsing', () => {
  assert.deepEqual(parseArgv(['--', 'git', '--version']), {
    action: 'run',
    command: ['git', '--version'],
    noSync: false,
  });
  assert.deepEqual(parseArgv(['-', 'foo']), {
    action: 'run',
    command: ['-', 'foo'],
    noSync: false,
  });
});

test('parses management actions', () => {
  for (const [flag, action] of [
    ['--init', 'init'],
    ['--status', 'status'],
    ['--ignore', 'ignore'],
    ['--sync', 'sync'],
    ['--reset', 'reset'],
  ]) {
    assert.deepEqual(parseArgv([flag]), { action, command: [], noSync: false });
  }
});

test('parses help and version aliases', () => {
  assert.equal(parseArgv(['--help']).action, 'help');
  assert.equal(parseArgv(['-h']).action, 'help');
  assert.equal(parseArgv(['--version']).action, 'version');
  assert.equal(parseArgv(['-v']).action, 'version');
});

test('no arguments shows help', () => {
  assert.deepEqual(parseArgv([]), { action: 'help', command: [], noSync: false });
});

test('rejects unknown options before the command', () => {
  assert.throws(() => parseArgv(['--bogus']), UsageError);
  assert.throws(() => parseArgv(['-x']), UsageError);
});

test('rejects management options with a command', () => {
  assert.throws(() => parseArgv(['--status', 'git', 'status']), UsageError);
});

test('rejects combining management options', () => {
  assert.throws(() => parseArgv(['--status', '--sync']), UsageError);
  assert.throws(() => parseArgv(['--init', '--init']), UsageError);
});

test('rejects invalid --no-sync usage', () => {
  assert.throws(() => parseArgv(['--no-sync']), UsageError);
  assert.throws(() => parseArgv(['--no-sync', '--sync']), UsageError);
  assert.throws(() => parseArgv(['--no-sync', '--no-sync', 'echo']), UsageError);
});

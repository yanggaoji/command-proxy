import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CliError } from '../src/errors.js';
import {
  buildManagedBlock,
  expandHome,
  isValidAlias,
  normalizePort,
  parseSshDestination,
  parseSshGOutput,
  removeManagedBlock,
  remoteRootProblem,
  resolveRemoteRoot,
  stripManagedBlock,
  upsertManagedBlock,
} from '../src/sshconfig.js';

function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'command-proxy-ssh-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const connection = {
  alias: 'cp-demo-abc123',
  hostname: '203.0.113.10',
  user: 'dev',
  port: 2222,
  identityFile: '~/.ssh/id_ed25519',
};

test('builds a managed SSH config block', () => {
  const block = buildManagedBlock('abc123', { ...connection, platform: 'linux' });
  assert.match(block, /^# >>> command-proxy:abc123 >>>$/m);
  assert.match(block, /^Host cp-demo-abc123$/m);
  assert.match(block, /^  HostName 203\.0\.113\.10$/m);
  assert.match(block, /^  User dev$/m);
  assert.match(block, /^  Port 2222$/m);
  assert.match(block, /^  IdentityFile ~\/\.ssh\/id_ed25519$/m);
  assert.match(block, /^  ServerAliveInterval 30$/m);
  assert.match(block, /^  ControlMaster auto$/m);
  assert.match(block, /^# <<< command-proxy:abc123 <<<$/m);
});

test('omits Control* settings on Windows', () => {
  const block = buildManagedBlock('abc123', { ...connection, platform: 'win32' });
  assert.doesNotMatch(block, /ControlMaster/);
  assert.doesNotMatch(block, /ControlPath/);
});

test('omits IdentityFile when it is empty', () => {
  const block = buildManagedBlock('abc123', { ...connection, identityFile: '' });
  assert.doesNotMatch(block, /IdentityFile/);
});

test('rejects invalid values in a managed block', () => {
  assert.throws(() => buildManagedBlock('../bad', connection), CliError);
  assert.throws(
    () => buildManagedBlock('abc123', { ...connection, alias: 'bad alias' }),
    CliError,
  );
  assert.throws(
    () => buildManagedBlock('abc123', { ...connection, hostname: 'bad\nHost evil' }),
    CliError,
  );
});

test('strips only the requested managed block', () => {
  const text = [
    'Host user-host',
    '  HostName example.com',
    '',
    '# >>> command-proxy:one >>>',
    'Host cp-one',
    '# <<< command-proxy:one <<<',
    '',
    '# >>> command-proxy:two >>>',
    'Host cp-two',
    '# <<< command-proxy:two <<<',
    '',
  ].join('\n');

  const result = stripManagedBlock(text, 'one');
  assert.equal(result.removed, true);
  assert.doesNotMatch(result.text, /command-proxy:one/);
  assert.match(result.text, /command-proxy:two/);
  assert.match(result.text, /Host user-host/);
});

test('throws instead of rewriting an incomplete block', () => {
  const text = '# >>> command-proxy:abc123 >>>\nHost broken\n';
  assert.throws(() => stripManagedBlock(text, 'abc123'), /incomplete/);
});

test('upserts a block and creates a backup', (t) => {
  const dir = tempDir(t);
  const configPath = path.join(dir, '.ssh', 'config');
  mkdirSync(path.dirname(configPath), { recursive: true });
  const original = 'Host user-host\n  HostName example.com\n';
  writeFileSync(configPath, original);

  const first = buildManagedBlock('abc123', connection);
  const firstResult = upsertManagedBlock('abc123', first, { configPath });
  assert.equal(firstResult.removed, false);
  assert.ok(firstResult.backupPath && existsSync(firstResult.backupPath));
  assert.equal(readFileSync(firstResult.backupPath, 'utf8'), original);

  const afterFirst = readFileSync(configPath, 'utf8');
  assert.ok(afterFirst.startsWith(original));
  assert.match(afterFirst, /Host cp-demo-abc123/);

  const second = buildManagedBlock('abc123', { ...connection, hostname: '198.51.100.1' });
  const secondResult = upsertManagedBlock('abc123', second, {
    configPath,
    backup: false,
  });
  assert.equal(secondResult.removed, true);

  const afterSecond = readFileSync(configPath, 'utf8');
  assert.equal((afterSecond.match(/# >>> command-proxy:abc123 >>>/g) || []).length, 1);
  assert.doesNotMatch(afterSecond, /203\.0\.113\.10/);
  assert.match(afterSecond, /198\.51\.100\.1/);
});

test('removes a block and restores the original content', (t) => {
  const dir = tempDir(t);
  const configPath = path.join(dir, '.ssh', 'config');
  mkdirSync(path.dirname(configPath), { recursive: true });
  const original = 'Host user-host\n  HostName example.com\n';
  writeFileSync(configPath, original);

  const block = buildManagedBlock('abc123', connection);
  upsertManagedBlock('abc123', block, { configPath, backup: false });
  const removed = removeManagedBlock('abc123', { configPath, backup: false });
  assert.equal(removed.removed, true);
  assert.equal(readFileSync(configPath, 'utf8'), original);
});

test('removal is a no-op when there is no matching block', (t) => {
  const dir = tempDir(t);
  const configPath = path.join(dir, 'config');
  writeFileSync(configPath, 'Host user-host\n');

  const result = removeManagedBlock('abc123', { configPath, backup: false });
  assert.equal(result.removed, false);
  assert.equal(readFileSync(configPath, 'utf8'), 'Host user-host\n');

  const missing = removeManagedBlock('abc123', {
    configPath: path.join(dir, 'missing'),
    backup: false,
  });
  assert.equal(missing.removed, false);
});

test('preserves CRLF line endings', (t) => {
  const dir = tempDir(t);
  const configPath = path.join(dir, 'config');
  const original = 'Host user-host\r\n  HostName example.com\r\n';
  writeFileSync(configPath, original);

  const block = buildManagedBlock('abc123', connection);
  upsertManagedBlock('abc123', block, { configPath, backup: false });
  assert.match(readFileSync(configPath, 'utf8'), /\r\n/);

  removeManagedBlock('abc123', { configPath, backup: false });
  assert.equal(readFileSync(configPath, 'utf8'), original);
});

test('parses ssh -G output', () => {
  const parsed = parseSshGOutput(
    [
      'hostname example.com',
      'user dev',
      'port 2222',
      'identityfile ~/.ssh/id_ed25519',
      'identityfile ~/.ssh/other',
      '',
    ].join('\n'),
  );
  assert.equal(parsed.hostname, 'example.com');
  assert.equal(parsed.user, 'dev');
  assert.equal(parsed.port, '2222');
  assert.equal(parsed.identityfile, '~/.ssh/id_ed25519');
});

test('parses SSH destinations', () => {
  assert.deepEqual(parseSshDestination('dev@example.com'), {
    user: 'dev',
    hostname: 'example.com',
    port: 22,
  });
  assert.deepEqual(parseSshDestination('dev@example.com:2222'), {
    user: 'dev',
    hostname: 'example.com',
    port: 2222,
  });
  assert.deepEqual(parseSshDestination('dev@[2001:db8::1]:22'), {
    user: 'dev',
    hostname: '2001:db8::1',
    port: 22,
  });
  assert.equal(parseSshDestination('example.com'), null);
  assert.equal(parseSshDestination('dev@example.com:99999'), null);
  assert.equal(parseSshDestination('de v@example.com'), null);
});

test('validates aliases, ports, and home expansion', () => {
  assert.equal(isValidAlias('myserver'), true);
  assert.equal(isValidAlias('cp-demo-abc123'), true);
  assert.equal(isValidAlias('user@host'), false);
  assert.equal(isValidAlias('-bad'), false);
  assert.equal(isValidAlias('bad alias'), false);

  assert.equal(normalizePort('22'), 22);
  assert.equal(normalizePort('0'), null);
  assert.equal(normalizePort('65536'), null);
  assert.equal(normalizePort('abc'), null);

  assert.equal(expandHome('~'), os.homedir());
  assert.equal(expandHome('~/key'), path.join(os.homedir(), 'key'));
  assert.equal(expandHome('/absolute/key'), '/absolute/key');
});

test('resolves remote paths against the remote home directory', () => {
  assert.equal(resolveRemoteRoot('/home/dev', '~'), '/home/dev');
  assert.equal(resolveRemoteRoot('/home/dev', '~/.command-proxy/x'), '/home/dev/.command-proxy/x');
  assert.equal(resolveRemoteRoot('/home/dev', '/srv/app/'), '/srv/app');
  assert.equal(resolveRemoteRoot('/home/dev', 'relative/path'), '/home/dev/relative/path');
  assert.equal(resolveRemoteRoot('/home/dev', '/'), '/');
});

test('guards dangerous remote roots', () => {
  assert.ok(remoteRootProblem('/home/dev', '/'));
  assert.ok(remoteRootProblem('/home/dev', '/home/dev'));
  assert.ok(remoteRootProblem('/home/dev', '/etc'));
  assert.equal(remoteRootProblem('/home/dev', '/home/dev/project'), null);
});

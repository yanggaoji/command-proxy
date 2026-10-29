import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { buildRemoteCommand, shQuote } from '../src/run.js';

test('quotes plain arguments', () => {
  assert.equal(shQuote('hello'), "'hello'");
  assert.equal(shQuote('hello world'), "'hello world'");
});

test('quotes empty strings', () => {
  assert.equal(shQuote(''), "''");
});

test('escapes single quotes', () => {
  assert.equal(shQuote("it's"), "'it'\\''s'");
  assert.equal(shQuote("''"), "''\\'''\\'''");
});

test('quotes shell metacharacters literally', () => {
  assert.equal(shQuote('$HOME'), "'$HOME'");
  assert.equal(shQuote('`date`'), "'`date`'");
  assert.equal(shQuote('a && b | c'), "'a && b | c'");
  assert.equal(shQuote('"double"'), "'\"double\"'");
  assert.equal(shQuote('中文'), "'中文'");
  assert.equal(shQuote('line1\nline2'), "'line1\nline2'");
  assert.equal(shQuote('back\\slash'), "'back\\slash'");
});

test('sshQuote round-trips through a POSIX shell', (t) => {
  const values = [
    '',
    'hello',
    'hello world',
    "it's",
    '"double"',
    '$HOME',
    '`date`',
    'line1\nline2',
    '中文',
    'a\\b',
    '!',
    '*',
  ];
  for (const value of values) {
    const result = spawnSync('sh', ['-c', `printf '%s' ${shQuote(value)}`], {
      encoding: 'utf8',
    });
    if (result.error) {
      t.skip('sh is not available');
      return;
    }
    assert.equal(result.stdout, value, `round-trip failed for ${JSON.stringify(value)}`);
  }
});

test('builds a plain remote command', () => {
  assert.equal(
    buildRemoteCommand('/remote dir', ['echo', "it's"], 'plain'),
    "cd '/remote dir' && 'echo' 'it'\\''s'",
  );
});

test('wraps the command in the remote login shell by default', () => {
  const inner = "cd '/remote' && 'git' 'clone' 'url'";
  assert.equal(
    buildRemoteCommand('/remote', ['git', 'clone', 'url'], 'login'),
    `exec "\${SHELL:-/bin/sh}" -lc ${shQuote(inner)}`,
  );
});

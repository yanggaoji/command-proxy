import assert from 'node:assert/strict';
import test from 'node:test';
import {
  conflictCount,
  createSessionArguments,
  describeState,
  describeStatus,
  mutagenVersionTooOld,
  normalizeSession,
  sessionLabel,
  sessionMatchesProject,
  sessionName,
} from '../src/sync.js';

test('builds Mutagen session names and labels', () => {
  const project = { id: 'abc123' };
  assert.equal(sessionName(project), 'cp-abc123');
  assert.equal(sessionLabel(project), 'command-proxy=abc123');
});

test('builds create arguments with two-way-safe mode and ignores', () => {
  const root = '/local/project';
  const project = {
    id: 'abc123',
    sshAlias: 'cp-demo-abc123',
    remoteRoot: '/home/dev/project',
  };
  const args = createSessionArguments(root, project, [
    'node_modules',
    '*.pyc',
    'a,b',
    'say"hi',
  ]);

  assert.deepEqual(args.slice(0, 5), [
    'sync',
    'create',
    '--name=cp-abc123',
    '--label=command-proxy=abc123',
    '--sync-mode=two-way-safe',
  ]);
  assert.ok(args.includes('--ignore=node_modules'));
  assert.ok(args.includes('--ignore=*.pyc'));
  assert.ok(args.includes('--ignore="a,b"'));
  assert.ok(args.includes('--ignore="say""hi"'));
  assert.equal(args.at(-2), root);
  assert.equal(args.at(-1), 'cp-demo-abc123:/home/dev/project');
});

test('normalizes Mutagen session JSON', () => {
  const session = normalizeSession({
    name: 'cp-abc123',
    status: 'watching',
    paused: false,
    alpha: { path: '/local' },
    beta: { host: 'cp-demo-abc123', path: '/remote' },
    conflicts: [{ root: 'a.txt' }, 'b.txt'],
    excludedConflicts: 2,
    lastError: 'boom',
  });

  assert.equal(session.name, 'cp-abc123');
  assert.equal(session.state, 'watching');
  assert.deepEqual(session.conflicts, ['a.txt', 'b.txt']);
  assert.equal(session.excludedConflicts, 2);
  assert.equal(session.lastError, 'boom');
  assert.equal(session.alphaPath, '/local');
  assert.equal(session.betaHost, 'cp-demo-abc123');
  assert.equal(session.betaPath, '/remote');
  assert.equal(conflictCount(session), 4);
});

test('detects a changed alias, local root, or remote root', () => {
  const root = '/local/project';
  const project = {
    sshAlias: 'cp-demo-abc123',
    remoteRoot: '/home/dev/project',
  };
  const base = {
    status: 'watching',
    alpha: { path: root },
    beta: { host: 'cp-demo-abc123', path: '/home/dev/project' },
  };

  assert.equal(sessionMatchesProject(root, project, normalizeSession(base)), true);
  assert.equal(
    sessionMatchesProject(
      root,
      project,
      normalizeSession({ ...base, beta: { ...base.beta, host: 'other-alias' } }),
    ),
    false,
  );
  assert.equal(
    sessionMatchesProject(
      root,
      project,
      normalizeSession({ ...base, alpha: { path: '/other/project' } }),
    ),
    false,
  );
  assert.equal(
    sessionMatchesProject(
      root,
      project,
      normalizeSession({ ...base, beta: { ...base.beta, path: '/other/project' } }),
    ),
    false,
  );
});

test('treats paused sessions as paused regardless of status', () => {
  const session = normalizeSession({ name: 'cp-x', paused: true, status: 'watching' });
  assert.equal(session.paused, true);
  assert.equal(session.state, 'paused');
});

test('recognizes Mutagen versions that lack JSON listings', () => {
  assert.equal(mutagenVersionTooOld('0.14.9'), true);
  assert.equal(mutagenVersionTooOld('0.15.0'), false);
  assert.equal(mutagenVersionTooOld('0.18.2'), false);
  assert.equal(mutagenVersionTooOld('1.0.0'), false);
  assert.equal(mutagenVersionTooOld('unknown'), false);
});

test('describes states', () => {
  assert.match(describeState('watching'), /watching for changes/);
  assert.match(describeState('halted-on-root-deletion'), /root was deleted/);
  assert.equal(describeState('a-new-state'), 'a-new-state');
});

test('describes status with and without a session', () => {
  const root = '/local/project';
  const project = {
    id: 'abc123',
    sshAlias: 'cp-demo-abc123',
    remoteRoot: '/home/dev/project',
  };
  const empty = describeStatus(root, project, null);
  assert.match(empty, /Session:  cp-abc123 \(not created yet\)/);
  assert.match(empty, /Remote:   cp-demo-abc123:\/home\/dev\/project/);

  const session = normalizeSession({
    name: 'cp-abc123',
    status: 'watching',
    conflicts: [{ root: 'a.txt' }, { root: 'b.txt' }],
    lastError: 'something',
  });
  const full = describeStatus(root, project, session);
  assert.match(full, /State:    watching for changes \(watching\)/);
  assert.match(full, /Conflicts: 2/);
  assert.match(full, /  - a\.txt/);
  assert.match(full, /Last error: something/);
});

test('accounts for conflicts hidden by output limits', () => {
  const root = '/local/project';
  const project = {
    id: 'abc123',
    sshAlias: 'cp-demo-abc123',
    remoteRoot: '/home/dev/project',
  };
  const conflicts = Array.from({ length: 25 }, (_, index) => ({
    root: `file-${index}.txt`,
  }));
  const session = normalizeSession({
    name: 'cp-abc123',
    status: 'watching',
    conflicts,
    excludedConflicts: 3,
  });

  const output = describeStatus(root, project, session);
  assert.match(output, /Conflicts: 28/);
  assert.match(output, /\.\.\. and 8 more/);
});

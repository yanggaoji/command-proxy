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
import {
  allocateProjectId,
  findProject,
  getPaths,
  loadConfig,
  pathsFor,
  projectSlug,
  realPath,
  remoteDirFor,
  saveConfig,
  unsafeProjectRootReason,
} from '../src/config.js';
import { CliError } from '../src/errors.js';

function tempDir(t) {
  const dir = realPath(mkdtempSync(path.join(os.tmpdir(), 'command-proxy-test-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const project = {
  id: 'abc123',
  sshAlias: 'cp-demo-abc123',
  remoteRoot: '/home/dev/.command-proxy/demo-abc123',
  shellMode: 'login',
  ignoreHash: 'hash',
};

test('saves and loads config', (t) => {
  const dir = tempDir(t);
  const paths = pathsFor(path.join(dir, 'state'));
  const config = { projects: { [dir]: { ...project } } };

  saveConfig(config, paths);
  assert.deepEqual(loadConfig(paths), config);
});

test('loadConfig returns an empty config when the file is missing or empty', (t) => {
  const dir = tempDir(t);
  const paths = pathsFor(path.join(dir, 'state'));
  assert.deepEqual(loadConfig(paths), { projects: {} });

  saveConfig({ projects: {} }, paths);
  writeFileSync(paths.configPath, '');
  assert.deepEqual(loadConfig(paths), { projects: {} });
});

test('loadConfig rejects invalid JSON and invalid entries', (t) => {
  const dir = tempDir(t);
  const paths = pathsFor(path.join(dir, 'state'));
  saveConfig({ projects: {} }, paths);

  writeFileSync(paths.configPath, '{');
  assert.throws(() => loadConfig(paths), CliError);

  writeFileSync(paths.configPath, JSON.stringify({ projects: { x: { id: 1 } } }));
  assert.throws(() => loadConfig(paths), CliError);
});

test('defaults an unknown shell mode to login', (t) => {
  const dir = tempDir(t);
  const paths = pathsFor(path.join(dir, 'state'));
  saveConfig(
    { projects: { [dir]: { ...project, shellMode: 'weird' } } },
    paths,
  );
  assert.equal(loadConfig(paths).projects[dir].shellMode, 'login');
});

test('rejects unsafe aliases and remote roots in config entries', (t) => {
  const dir = tempDir(t);
  const paths = pathsFor(path.join(dir, 'state'));

  saveConfig(
    { projects: { [dir]: { ...project, sshAlias: '-oProxyCommand=evil' } } },
    paths,
  );
  assert.throws(() => loadConfig(paths), CliError);

  saveConfig(
    { projects: { [dir]: { ...project, remoteRoot: 'relative/path' } } },
    paths,
  );
  assert.throws(() => loadConfig(paths), CliError);

  saveConfig(
    { projects: { [dir]: { ...project, remoteRoot: '/' } } },
    paths,
  );
  assert.throws(() => loadConfig(paths), CliError);
});

test('findProject finds the nearest registered parent', (t) => {
  const root = tempDir(t);
  const deep = path.join(root, 'src', 'deep');
  mkdirSync(deep, { recursive: true });
  const config = { projects: { [root]: { ...project } } };

  assert.deepEqual(findProject(deep, config), { root, project: config.projects[root] });
  assert.deepEqual(findProject(root, config), { root, project: config.projects[root] });
  assert.equal(findProject(path.dirname(root), config), null);
  assert.equal(findProject(root, { projects: {} }), null);
});

test('findProject compares paths case-insensitively on Windows', (t) => {
  if (process.platform !== 'win32') {
    return;
  }
  const root = tempDir(t);
  const config = { projects: { [root]: { ...project } } };
  assert.ok(findProject(root.toUpperCase(), config));
});

test('maps a local directory into the remote root', (t) => {
  const root = tempDir(t);
  const sub = path.join(root, 'src', 'app');
  mkdirSync(sub, { recursive: true });

  const entry = { remoteRoot: '/home/dev/project' };
  assert.equal(remoteDirFor(root, entry, root), '/home/dev/project');
  assert.equal(remoteDirFor(root, entry, sub), '/home/dev/project/src/app');
  assert.throws(() => remoteDirFor(root, entry, path.dirname(root)), CliError);

  const dotName = path.join(root, '..data');
  mkdirSync(dotName);
  assert.equal(remoteDirFor(root, entry, dotName), '/home/dev/project/..data');
});

test('refuses home directories, filesystem roots, and system directories', (t) => {
  const root = tempDir(t);
  assert.ok(unsafeProjectRootReason(os.homedir()));
  assert.ok(unsafeProjectRootReason(path.parse(realPath(root)).root));
  assert.equal(unsafeProjectRootReason(root), null);

  if (process.platform === 'win32') {
    if (process.env.SystemRoot) {
      assert.ok(unsafeProjectRootReason(process.env.SystemRoot));
    }
  } else {
    assert.ok(unsafeProjectRootReason('/etc'));
  }
});

test('allocates stable, unique project ids', (t) => {
  const one = tempDir(t);
  const two = tempDir(t);
  const first = allocateProjectId(one, {});
  assert.equal(first.length, 6);
  assert.equal(allocateProjectId(one, {}), first);
  assert.equal(allocateProjectId(one, {}, 'existing'), 'existing');

  const second = allocateProjectId(two, { [one]: { id: first } });
  assert.notEqual(second, first);
});

test('builds a safe project slug', (t) => {
  const root = tempDir(t);
  assert.equal(projectSlug(path.join(root, 'My Project!')), 'my-project');
  assert.equal(projectSlug(path.join(root, '项目')), 'project');
  assert.equal(projectSlug(path.join(root, 'a'.repeat(100))), 'a'.repeat(30));
});

test('builds platform-specific global paths', () => {
  const win = getPaths({ APPDATA: 'C:\\Users\\test\\AppData\\Roaming' }, 'win32');
  assert.equal(win.dir, path.join('C:\\Users\\test\\AppData\\Roaming', 'command-proxy'));
  assert.equal(win.configPath, path.join(win.dir, 'config.json'));

  const linux = getPaths({}, 'linux');
  assert.equal(linux.dir, path.join(os.homedir(), '.config', 'command-proxy'));

  const xdg = getPaths({ XDG_CONFIG_HOME: '/tmp/xdg' }, 'linux');
  assert.equal(xdg.dir, path.join('/tmp/xdg', 'command-proxy'));
});

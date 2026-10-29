import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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
import { fileURLToPath } from 'node:url';
import {
  getPaths,
  loadConfig,
  realPath,
  saveConfig,
} from '../src/config.js';
import {
  collectIgnorePatterns,
  ensureGlobalIgnoreFile,
  hashIgnorePatterns,
} from '../src/ignore.js';
import { shQuote } from '../src/run.js';
import { readRemoteHome } from '../src/sshconfig.js';
import { mutagenExecutable } from '../src/mutagen.js';
import {
  checkMutagen,
  mutagenVersionTooOld,
  sessionName,
} from '../src/sync.js';

const bin = fileURLToPath(new URL('../bin/command-proxy.js', import.meta.url));
const alias = process.env.COMMAND_PROXY_TEST_SSH_ALIAS;

test(
  'runs commands remotely and syncs files both ways',
  { skip: alias ? false : 'set COMMAND_PROXY_TEST_SSH_ALIAS to run the integration test' },
  (t) => {
    if (!alias) {
      t.skip('set COMMAND_PROXY_TEST_SSH_ALIAS to run the integration test');
      return;
    }

    const mutagen = checkMutagen();
    if (!mutagen.available) {
      t.skip(`Mutagen is unavailable: ${mutagen.reason}`);
      return;
    }
    if (mutagenVersionTooOld(mutagen.version)) {
      t.skip(`Mutagen ${mutagen.version} is too old`);
      return;
    }

    const probe = readRemoteHome(alias);
    assert.equal(
      probe.ok,
      true,
      `cannot connect to ${alias}: ${probe.stderr || probe.error?.message || ''}`,
    );

    const id = `it${randomBytes(4).toString('hex')}`;
    const root = realPath(mkdtempSync(path.join(os.tmpdir(), 'command-proxy-it-')));
    const stateRoot = realPath(mkdtempSync(path.join(os.tmpdir(), 'command-proxy-it-state-')));
    const env = {
      ...process.env,
      APPDATA: stateRoot,
      XDG_CONFIG_HOME: stateRoot,
    };

    const paths = getPaths(env);
    assert.ok(paths.dir.startsWith(stateRoot), 'the test must use an isolated config directory');

    const remoteRoot = `${probe.home}/.command-proxy-it-${id}`;
    const project = {
      id,
      sshAlias: alias,
      remoteRoot,
      shellMode: 'login',
    };

    ensureGlobalIgnoreFile(paths);
    const patterns = collectIgnorePatterns(root, paths);
    project.ignoreHash = hashIgnorePatterns(patterns);
    saveConfig({ projects: { [root]: project } }, paths);

    writeFileSync(path.join(root, 'initial.txt'), 'from-local\n');

    t.after(() => {
      spawnSync(process.execPath, [bin, '--reset'], {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 120_000,
      });
      spawnSync(mutagenExecutable(), ['sync', 'terminate', sessionName(project)], {
        stdio: 'ignore',
      });
      spawnSync('ssh', [alias, `rm -rf ${shQuote(remoteRoot)}`], {
        stdio: 'ignore',
        timeout: 60_000,
      });
      rmSync(root, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    });

    const cli = (args, options = {}) =>
      spawnSync(process.execPath, [bin, ...args], {
        cwd: options.cwd || root,
        env,
        encoding: 'utf8',
        input: options.input,
        timeout: 300_000,
      });

    // First run creates the session, pushes the directory, and runs remotely.
    const initial = cli(['cat', 'initial.txt']);
    assert.equal(initial.status, 0, initial.stderr);
    assert.equal(initial.stdout, 'from-local\n');

    // Exit codes are passed through unchanged.
    const exitThree = cli(['sh', '-c', 'exit 3']);
    assert.equal(exitThree.status, 3);

    // Files created remotely are flushed back before the process exits.
    const createRemote = cli(['sh', '-c', 'printf remote > created.txt']);
    assert.equal(createRemote.status, 0, createRemote.stderr);
    assert.equal(readFileSync(path.join(root, 'created.txt'), 'utf8'), 'remote');

    // Ignored files created remotely are not downloaded.
    const createIgnored = cli([
      'sh',
      '-c',
      'mkdir -p node_modules && printf x > node_modules/x.txt',
    ]);
    assert.equal(createIgnored.status, 0, createIgnored.stderr);
    assert.equal(existsSync(path.join(root, 'node_modules')), false);

    // Stdin is forwarded, and stdout contains only the command's output.
    const piped = cli(['cat'], { input: 'hi\n' });
    assert.equal(piped.status, 0);
    assert.equal(piped.stdout, 'hi\n');

    // Running from a subdirectory uses the matching remote subdirectory.
    const sub = path.join(root, 'sub');
    mkdirSync(sub);
    writeFileSync(path.join(sub, 'note.txt'), 'note\n');
    const pwd = cli(['pwd'], { cwd: sub });
    assert.equal(pwd.status, 0, pwd.stderr);
    assert.equal(pwd.stdout.trim(), `${remoteRoot}/sub`);

    // --status, --sync, and --no-sync are functional.
    const status = cli(['--status']);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /State:/);
    assert.match(status.stdout, /Conflicts: 0/);

    const sync = cli(['--sync']);
    assert.equal(sync.status, 0, sync.stderr);

    const noSync = cli(['--no-sync', 'echo', 'no-sync-ok']);
    assert.equal(noSync.status, 0, noSync.stderr);
    assert.equal(noSync.stdout, 'no-sync-ok\n');

    // --reset removes the config but leaves the files alone.
    const reset = cli(['--reset']);
    assert.equal(reset.status, 0, reset.stderr);
    assert.equal(Object.keys(loadConfig(paths).projects).length, 0);
    assert.ok(existsSync(path.join(root, 'initial.txt')));
  },
);

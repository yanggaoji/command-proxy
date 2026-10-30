import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installArchive, installMutagen } from '../src/mutagen-install.js';
import {
  MUTAGEN_VERSION,
  mutagenAssetName,
  mutagenBinaryName,
  mutagenReleaseUrl,
  mutagenTarget,
  parseChecksums,
} from '../src/mutagen.js';

function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'command-proxy-mutagen-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Build a miniature release archive with the same layout as Mutagen's own
 * archives: the executable and the agent bundle at the root.
 */
function makeArchive(dir, asset) {
  const source = path.join(dir, 'source');
  mkdirSync(source);
  writeFileSync(
    path.join(source, mutagenBinaryName()),
    `fake mutagen ${MUTAGEN_VERSION}\n`,
  );
  writeFileSync(path.join(source, 'mutagen-agents.tar.gz'), 'fake agents\n');

  const archive = path.join(dir, asset);
  const result = spawnSync('tar', ['-czf', asset, '-C', 'source', '.'], {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return archive;
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function serveRelease(t, { asset, archive, checksum }) {
  const server = createServer((request, response) => {
    if (request.url === `/${asset}`) {
      response.end(readFileSync(archive));
    } else if (request.url === '/SHA256SUMS') {
      response.end(`${checksum}  ${asset}\n`);
    } else {
      response.statusCode = 404;
      response.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

/** A minimal CONNECT proxy, which is what undici's ProxyAgent uses. */
async function serveProxy(t) {
  let connections = 0;
  const server = createServer();
  server.on('connect', (request, clientSocket, head) => {
    connections += 1;
    const index = request.url.lastIndexOf(':');
    const host = request.url.slice(0, index);
    const port = Number(request.url.slice(index + 1));
    const upstream = connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    connections: () => connections,
  };
}

test('maps Node platforms and architectures to Mutagen targets', () => {
  assert.deepEqual(mutagenTarget('win32', 'x64', 'LE'), {
    goos: 'windows',
    goarch: 'amd64',
  });
  assert.deepEqual(mutagenTarget('darwin', 'arm64', 'LE'), {
    goos: 'darwin',
    goarch: 'arm64',
  });
  assert.deepEqual(mutagenTarget('linux', 'ia32', 'LE'), {
    goos: 'linux',
    goarch: '386',
  });
  assert.deepEqual(mutagenTarget('linux', 'ppc64', 'LE'), {
    goos: 'linux',
    goarch: 'ppc64le',
  });
  assert.deepEqual(mutagenTarget('linux', 'ppc64', 'BE'), {
    goos: 'linux',
    goarch: 'ppc64',
  });
  assert.deepEqual(mutagenTarget('sunos', 'x64', 'LE'), {
    goos: 'solaris',
    goarch: 'amd64',
  });
  assert.equal(mutagenTarget('android', 'arm64', 'LE'), null);
  assert.equal(mutagenTarget('linux', 'loong64', 'LE'), null);
});

test('builds release asset names and URLs', () => {
  const target = { goos: 'windows', goarch: 'amd64' };
  assert.equal(
    mutagenAssetName('0.18.1', target),
    'mutagen_windows_amd64_v0.18.1.tar.gz',
  );
  assert.equal(
    mutagenReleaseUrl('SHA256SUMS', '0.18.1'),
    'https://github.com/mutagen-io/mutagen/releases/download/v0.18.1/SHA256SUMS',
  );
});

test('parses checksum files', () => {
  const first = 'a'.repeat(64);
  const second = 'B'.repeat(64);
  const checksums = parseChecksums(
    `${first}  mutagen_windows_amd64_v0.18.1.tar.gz\n` +
      `${second} *SHA256SUMS\n` +
      'not a checksum\n',
  );

  assert.equal(
    checksums.get('mutagen_windows_amd64_v0.18.1.tar.gz'),
    first,
  );
  assert.equal(checksums.get('SHA256SUMS'), second.toLowerCase());
  assert.equal(checksums.size, 2);
});

test('extracts the executable and agent bundle into place', (t) => {
  const dir = tempDir(t);
  const asset = 'mutagen_test_test_v0.18.1.tar.gz';
  const archive = makeArchive(dir, asset);
  const staging = path.join(dir, 'staging');
  const destination = path.join(dir, 'vendor');
  mkdirSync(staging);

  const installed = installArchive(archive, staging, destination);

  assert.equal(installed, path.join(destination, mutagenBinaryName()));
  assert.match(readFileSync(installed, 'utf8'), /fake mutagen/);
  assert.equal(
    readFileSync(path.join(destination, 'mutagen-agents.tar.gz'), 'utf8'),
    'fake agents\n',
  );
  if (process.platform !== 'win32') {
    assert.ok((statSync(installed).mode & 0o111) !== 0, 'the binary must be executable');
  }
});

test('downloads, verifies, and installs a release', async (t) => {
  const dir = tempDir(t);
  const asset = 'mutagen_test_test_v0.18.1.tar.gz';
  const archive = makeArchive(dir, asset);
  const checksum = sha256(archive);
  const baseUrl = await serveRelease(t, { asset, archive, checksum });
  const destination = path.join(dir, 'installed');

  const result = await installMutagen({
    version: '0.18.1',
    target: { goos: 'test', goarch: 'test' },
    destinationDir: destination,
    releaseUrl: (name) => `${baseUrl}/${name}`,
    force: true,
    proxy: null,
    log: () => {},
  });

  assert.equal(result.installed, true);
  assert.equal(result.path, path.join(destination, mutagenBinaryName()));
  assert.ok(existsSync(path.join(destination, 'mutagen-agents.tar.gz')));
});

test('downloads through an explicit proxy', async (t) => {
  const dir = tempDir(t);
  const asset = 'mutagen_test_test_v0.18.1.tar.gz';
  const archive = makeArchive(dir, asset);
  const checksum = sha256(archive);
  const baseUrl = await serveRelease(t, { asset, archive, checksum });
  const proxy = await serveProxy(t);
  const destination = path.join(dir, 'installed');
  const logs = [];

  const result = await installMutagen({
    version: '0.18.1',
    target: { goos: 'test', goarch: 'test' },
    destinationDir: destination,
    releaseUrl: (name) => `${baseUrl}/${name}`,
    force: true,
    proxy: proxy.url,
    log: (message) => logs.push(message),
  });

  assert.equal(result.installed, true);
  assert.ok(proxy.connections() > 0, 'the download must use the proxy');
  assert.ok(logs.some((message) => message.includes('using proxy')));
});

test('rejects a release whose checksum does not match', async (t) => {
  const dir = tempDir(t);
  const asset = 'mutagen_test_test_v0.18.1.tar.gz';
  const archive = makeArchive(dir, asset);
  const baseUrl = await serveRelease(t, {
    asset,
    archive,
    checksum: '0'.repeat(64),
  });

  await assert.rejects(
    installMutagen({
      version: '0.18.1',
      target: { goos: 'test', goarch: 'test' },
      destinationDir: path.join(dir, 'installed'),
      releaseUrl: (name) => `${baseUrl}/${name}`,
      force: true,
      proxy: null,
      log: () => {},
    }),
    /checksum mismatch/,
  );
});

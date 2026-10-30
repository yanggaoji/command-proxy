import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { redactProxy, resolveProxy } from './proxy.js';
import {
  MUTAGEN_VERSION,
  bundledMutagenDir,
  bundledMutagenReady,
  mutagenAssetName,
  mutagenBinaryName,
  mutagenReleaseUrl,
  mutagenTarget,
  mutagenVersionTooOld,
  parseChecksums,
} from './mutagen.js';

const AGENTS_NAME = 'mutagen-agents.tar.gz';

function defaultLog(message) {
  process.stderr.write(`command-proxy: ${message}\n`);
}

/**
 * An existing Mutagen on PATH is left alone, unless --force is used. One that
 * is too old does not prevent installing the bundled copy, which takes
 * precedence over PATH at runtime anyway.
 */
function systemMutagenUsable() {
  const result = spawnSync('mutagen', ['version'], {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    return false;
  }
  const version = `${result.stderr || ''}${result.stdout || ''}`.trim();
  return !mutagenVersionTooOld(version);
}

async function downloadFile(url, destination, proxy) {
  const dispatcher = proxy ? new ProxyAgent(proxy) : null;
  try {
    const request = dispatcher ? undiciFetch : fetch;
    const response = await request(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(10 * 60_000),
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (!response.ok || !response.body) {
      throw new Error(
        `download failed (${response.status} ${response.statusText}): ${url}`,
      );
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
  } finally {
    if (dispatcher) {
      await dispatcher.destroy();
    }
  }
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function isGnuTar() {
  const result = spawnSync('tar', ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  });
  return !result.error && /gnu tar/i.test(result.stdout || '');
}

function extractArchive(archive, destination) {
  const args = [];
  // GNU tar on Windows mistakes the drive letter in an absolute path for a
  // remote host name. bsdtar, the tar shipped with Windows, does not.
  if (process.platform === 'win32' && isGnuTar()) {
    args.push('--force-local');
  }
  args.push('-xzf', archive, '-C', destination);
  const result = spawnSync('tar', args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 300_000,
  });
  if (result.error) {
    throw new Error(`cannot run tar: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(
      `tar failed${detail ? `: ${detail}` : ` with status ${result.status}`}`,
    );
  }
}

function copyIntoPlace(source, destination, { executable = false } = {}) {
  const pending = `${destination}.${process.pid}.tmp`;
  try {
    copyFileSync(source, pending);
    if (executable && process.platform !== 'win32') {
      chmodSync(pending, 0o755);
    }
    renameSync(pending, destination);
  } catch (err) {
    rmSync(pending, { force: true });
    throw err;
  }
}

/**
 * Extract a downloaded release archive into `destinationDir`. Exported for
 * tests; the archive is expected to contain the executable and the agent
 * bundle at its root, which is how Mutagen packages releases.
 *
 * @param {string} archive
 * @param {string} stagingDir an existing directory for the extracted files
 * @param {string} [destinationDir]
 * @returns {string} path to the installed executable
 */
export function installArchive(
  archive,
  stagingDir,
  destinationDir = bundledMutagenDir(),
) {
  const extractDir = mkdtempSync(path.join(stagingDir, 'extract-'));
  extractArchive(archive, extractDir);

  const binaryName = mutagenBinaryName();
  const binarySource = path.join(extractDir, binaryName);
  const agentsSource = path.join(extractDir, AGENTS_NAME);
  for (const source of [binarySource, agentsSource]) {
    if (!existsSync(source)) {
      throw new Error(
        `the Mutagen archive does not contain ${path.basename(source)}`,
      );
    }
  }

  mkdirSync(destinationDir, { recursive: true });
  const binaryDest = path.join(destinationDir, binaryName);
  // The agent bundle goes first so a partially completed install is never
  // mistaken for a usable one by bundledMutagenReady.
  copyIntoPlace(agentsSource, path.join(destinationDir, AGENTS_NAME));
  copyIntoPlace(binarySource, binaryDest, { executable: true });
  return binaryDest;
}

/**
 * Download, verify, and install a Mutagen release unless a usable copy already
 * exists. The caller decides whether a failure should fail `npm install`;
 * command-proxy treats it as a warning and reports the problem at runtime.
 *
 * @param {{
 *   version?: string,
 *   target?: { goos: string, goarch: string } | null,
 *   destinationDir?: string,
 *   releaseUrl?: (filename: string) => string,
 *   force?: boolean,
 *   proxy?: string | null,
 *   log?: (message: string) => void,
 * }} [options]
 * @returns {Promise<{ installed: boolean, path?: string, reason?: string }>}
 */
export async function installMutagen(options = {}) {
  const {
    version = MUTAGEN_VERSION,
    target = mutagenTarget(),
    destinationDir = bundledMutagenDir(version),
    releaseUrl = (filename) => mutagenReleaseUrl(filename, version),
    force = false,
    log = defaultLog,
  } = options;

  if (!force) {
    if (bundledMutagenReady(version)) {
      return { installed: false, reason: 'bundled' };
    }
    if (systemMutagenUsable()) {
      return { installed: false, reason: 'system' };
    }
  }

  if (!target) {
    throw new Error(
      `there is no prebuilt Mutagen release for ${process.platform}/${process.arch}`,
    );
  }

  const asset = mutagenAssetName(version, target);
  const proxy =
    options.proxy === undefined
      ? resolveProxy(releaseUrl('SHA256SUMS'))
      : options.proxy;
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'command-proxy-mutagen-'));
  try {
    log(`Mutagen ${version} is not installed; downloading ${asset}...`);
    if (proxy) {
      log(`using proxy ${redactProxy(proxy)}`);
    }
    const archive = path.join(tempDir, asset);
    const checksums = path.join(tempDir, 'SHA256SUMS');
    await downloadFile(releaseUrl('SHA256SUMS'), checksums, proxy);

    const expected = parseChecksums(readFileSync(checksums, 'utf8')).get(asset);
    if (!expected) {
      throw new Error(`SHA256SUMS does not list ${asset}`);
    }

    await downloadFile(releaseUrl(asset), archive, proxy);
    const actual = await sha256File(archive);
    if (actual !== expected) {
      throw new Error(`checksum mismatch for ${asset}`);
    }

    const installed = installArchive(archive, tempDir, destinationDir);
    log(`installed Mutagen ${version} at ${installed}`);
    return { installed: true, path: installed };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

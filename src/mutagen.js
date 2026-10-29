import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The Mutagen release downloaded by `npm install`. Pinned so installs are
 * reproducible; 0.18.1 is the release this version of command-proxy is tested
 * against. Changing it is enough to pick up another release.
 */
export const MUTAGEN_VERSION = '0.18.1';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

const GOOS = {
  win32: 'windows',
  darwin: 'darwin',
  linux: 'linux',
  freebsd: 'freebsd',
  openbsd: 'openbsd',
  netbsd: 'netbsd',
  aix: 'aix',
  sunos: 'solaris',
};

const GOARCH = {
  x64: 'amd64',
  ia32: '386',
  arm64: 'arm64',
  arm: 'arm',
  mips: 'mips',
  mipsel: 'mipsle',
  mips64: 'mips64',
  mips64el: 'mips64le',
  ppc64: 'ppc64',
  riscv64: 'riscv64',
  s390x: 's390x',
};

/**
 * Map Node's platform and architecture names to the GOOS/GOARCH pair used in
 * Mutagen release asset names. Returns null when there is no release asset.
 *
 * @param {NodeJS.Platform} [platform]
 * @param {NodeJS.Architecture} [arch]
 * @param {"LE" | "BE"} [endianness]
 * @returns {{ goos: string, goarch: string } | null}
 */
export function mutagenTarget(
  platform = process.platform,
  arch = process.arch,
  endianness = os.endianness(),
) {
  const goos = GOOS[platform];
  let goarch = GOARCH[arch];
  if (arch === 'ppc64' && endianness === 'LE') {
    goarch = 'ppc64le';
  }
  if (!goos || !goarch) {
    return null;
  }
  return { goos, goarch };
}

/**
 * @param {string} version
 * @param {{ goos: string, goarch: string }} target
 */
export function mutagenAssetName(version, target) {
  return `mutagen_${target.goos}_${target.goarch}_v${version}.tar.gz`;
}

/**
 * @param {string} filename
 * @param {string} [version]
 */
export function mutagenReleaseUrl(filename, version = MUTAGEN_VERSION) {
  return `https://github.com/mutagen-io/mutagen/releases/download/v${version}/${filename}`;
}

/**
 * @param {string} [version]
 */
export function bundledMutagenDir(version = MUTAGEN_VERSION) {
  return path.join(PACKAGE_ROOT, 'vendor', 'mutagen', `v${version}`);
}

/**
 * @param {NodeJS.Platform} [platform]
 */
export function mutagenBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'mutagen.exe' : 'mutagen';
}

/**
 * @param {string} [version]
 */
export function bundledMutagenPath(version = MUTAGEN_VERSION) {
  return path.join(bundledMutagenDir(version), mutagenBinaryName());
}

/**
 * The agent bundle must sit next to the executable for remote sessions to
 * work, so both files are required for a usable bundled installation.
 *
 * @param {string} [version]
 */
export function bundledMutagenReady(version = MUTAGEN_VERSION) {
  return (
    existsSync(bundledMutagenPath(version)) &&
    existsSync(path.join(bundledMutagenDir(version), 'mutagen-agents.tar.gz'))
  );
}

/**
 * Prefer the binary installed by `npm install`, falling back to `mutagen` on
 * PATH for users who manage it themselves.
 */
export function mutagenExecutable() {
  return bundledMutagenReady() ? bundledMutagenPath() : 'mutagen';
}

/**
 * Parse a Mutagen SHA256SUMS file.
 *
 * @param {string} text
 * @returns {Map<string, string>} file name to lowercase checksum
 */
export function parseChecksums(text) {
  const checksums = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (match) {
      checksums.set(match[2], match[1].toLowerCase());
    }
  }
  return checksums;
}

/**
 * JSON session listings require Mutagen 0.15 or newer.
 *
 * @param {string} version
 */
export function mutagenVersionTooOld(version) {
  const match = /(\d+)\.(\d+)/.exec(version || '');
  if (!match) {
    return false;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major === 0 && minor < 15;
}

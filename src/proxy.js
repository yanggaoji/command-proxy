import { spawnSync } from 'node:child_process';

/**
 * Windows stores its system proxy in the registry. Node's fetch does not read
 * it, so the Mutagen download would otherwise connect directly even when the
 * proxy in Settings is enabled.
 */
const WINDOWS_INTERNET_SETTINGS =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

const ENV_VARIABLES = {
  'https:': ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'],
  'http:': ['HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'],
};

function splitHostPort(entry) {
  if (entry.startsWith('[')) {
    const match = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
    return match ? { host: match[1], port: match[2] } : null;
  }
  const colon = entry.lastIndexOf(':');
  // A second colon means this is a bare IPv6 address, not host:port.
  if (
    colon > 0 &&
    entry.indexOf(':') === colon &&
    /^\d+$/.test(entry.slice(colon + 1))
  ) {
    return { host: entry.slice(0, colon), port: entry.slice(colon + 1) };
  }
  return { host: entry, port: undefined };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hostMatches(pattern, host) {
  if (pattern === host) {
    return true;
  }
  if (pattern.startsWith('.')) {
    return host === pattern.slice(1) || host.endsWith(pattern);
  }
  if (pattern.includes('*')) {
    const source = pattern.split('*').map(escapeRegExp).join('.*');
    return new RegExp(`^${source}$`).test(host);
  }
  return host.endsWith(`.${pattern}`);
}

/**
 * Whether `url` is excluded from proxying by a NO_PROXY or ProxyOverride
 * value. Entries may be separated by commas or semicolons.
 *
 * @param {URL} url
 * @param {string} entries
 */
export function bypassesProxy(url, entries) {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  for (const raw of String(entries || '').split(/[;,]/)) {
    const entry = raw.trim().toLowerCase();
    if (!entry) {
      continue;
    }
    if (entry === '*') {
      return true;
    }
    if (entry === '<local>') {
      if (!host.includes('.') || host === '::1' || host.startsWith('127.')) {
        return true;
      }
      continue;
    }
    const parsed = splitHostPort(entry);
    if (!parsed || (parsed.port && parsed.port !== port)) {
      continue;
    }
    if (hostMatches(parsed.host, host)) {
      return true;
    }
  }
  return false;
}

/**
 * Turn an env or registry proxy value into a URL. Bare `host:port` values are
 * treated as HTTP proxies; other schemes (such as SOCKS) are not supported.
 *
 * @param {string} value
 * @returns {string | null}
 */
export function normalizeProxy(value) {
  const text = String(value).trim();
  if (!text) {
    return null;
  }
  let url;
  try {
    url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`,
    );
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }
  return url.href;
}

/**
 * Parse the values printed by `reg query` into a plain object.
 *
 * @param {string} output
 */
export function parseWindowsProxySettings(output) {
  const settings = {};
  for (const line of String(output).split(/\r?\n/)) {
    const match = /^\s+(\S+)\s+REG_[A-Z_]+\s+(.*?)\s*$/.exec(line);
    if (match) {
      settings[match[1]] = match[2];
    }
  }
  return settings;
}

function proxyServerFor(protocol, value) {
  const text = String(value || '').trim();
  if (!text) {
    return null;
  }
  if (!text.includes('=')) {
    return text;
  }
  const scheme = protocol.slice(0, -1).toLowerCase();
  const entries = new Map();
  for (const part of text.split(';')) {
    const index = part.indexOf('=');
    if (index > 0) {
      entries.set(
        part.slice(0, index).trim().toLowerCase(),
        part.slice(index + 1).trim(),
      );
    }
  }
  // Some proxy clients write only http= and expect HTTPS to use it too.
  return entries.get(scheme) || (scheme === 'https' && entries.get('http')) || null;
}

/**
 * Resolve `url` against parsed Windows Internet Settings.
 *
 * @param {URL} url
 * @param {Record<string, string>} settings
 * @returns {string | null}
 */
export function proxyFromWindowsSettings(url, settings) {
  if (!settings || Number(settings.ProxyEnable) !== 1) {
    return null;
  }
  const server = proxyServerFor(url.protocol, settings.ProxyServer);
  if (!server) {
    return null;
  }
  if (bypassesProxy(url, settings.ProxyOverride || '')) {
    return null;
  }
  return normalizeProxy(server);
}

function readWindowsProxySettings() {
  const result = spawnSync('reg', ['query', WINDOWS_INTERNET_SETTINGS], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  return parseWindowsProxySettings(result.stdout || '');
}

/**
 * Resolve the proxy for `url`. Environment variables win over the Windows
 * system proxy; NO_PROXY bypasses both. Returns null for a direct connection.
 *
 * @param {string} url
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform }} [options]
 * @returns {string | null}
 */
export function resolveProxy(
  url,
  { env = process.env, platform = process.platform } = {},
) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  if (!ENV_VARIABLES[target.protocol]) {
    return null;
  }

  if (bypassesProxy(target, env.NO_PROXY || env.no_proxy || '')) {
    return null;
  }

  for (const name of ENV_VARIABLES[target.protocol]) {
    const value = env[name];
    if (value && value.trim()) {
      return normalizeProxy(value);
    }
  }

  if (platform === 'win32') {
    return proxyFromWindowsSettings(target, readWindowsProxySettings());
  }
  return null;
}

/**
 * Hide the password before a proxy URL is written to the log.
 *
 * @param {string} proxy
 */
export function redactProxy(proxy) {
  try {
    const url = new URL(proxy);
    const auth = url.username || url.password ? `${url.username}:***@` : '';
    return `${url.protocol}//${auth}${url.host}${url.pathname}`;
  } catch {
    return '(invalid proxy)';
  }
}

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bypassesProxy,
  normalizeProxy,
  parseWindowsProxySettings,
  proxyFromWindowsSettings,
  redactProxy,
  resolveProxy,
} from '../src/proxy.js';

const windows = { platform: 'win32' };
const linux = { platform: 'linux' };

test('reads proxy settings from the environment', () => {
  assert.equal(
    resolveProxy('https://github.com/file', {
      ...linux,
      env: { HTTPS_PROXY: 'http://127.0.0.1:7890' },
    }),
    'http://127.0.0.1:7890/',
  );
  assert.equal(
    resolveProxy('https://github.com/file', {
      ...linux,
      env: { https_proxy: 'proxy.example:8080' },
    }),
    'http://proxy.example:8080/',
  );
  assert.equal(
    resolveProxy('https://github.com/file', {
      ...linux,
      env: { ALL_PROXY: 'http://proxy.example:8081' },
    }),
    'http://proxy.example:8081/',
  );
});

test('uses HTTP_PROXY only for HTTP targets', () => {
  assert.equal(
    resolveProxy('http://example.com/file', {
      ...linux,
      env: { HTTP_PROXY: 'http://proxy.example:8080' },
    }),
    'http://proxy.example:8080/',
  );
  assert.equal(
    resolveProxy('https://example.com/file', {
      ...linux,
      env: { HTTPS_PROXY: 'http://secure.example:8081' },
    }),
    'http://secure.example:8081/',
  );
  assert.equal(
    resolveProxy('http://example.com/file', {
      ...linux,
      env: { HTTPS_PROXY: 'http://secure.example:8081' },
    }),
    null,
  );
});

test('NO_PROXY excludes matching hosts and ports', () => {
  const env = {
    HTTPS_PROXY: 'http://proxy.example:8080',
    NO_PROXY: 'github.com,.internal.example,127.0.0.1:8443',
  };
  const resolve = (url) => resolveProxy(url, { ...linux, env });

  assert.equal(resolve('https://github.com/file'), null);
  assert.equal(resolve('https://api.github.com/file'), null);
  assert.equal(resolve('https://host.internal.example/file'), null);
  assert.equal(resolve('https://127.0.0.1:8443/file'), null);
  assert.equal(
    resolve('https://127.0.0.1:9443/file'),
    'http://proxy.example:8080/',
  );
  assert.equal(
    resolve('https://example.com/file'),
    'http://proxy.example:8080/',
  );
});

test('matches wildcard bypass entries', () => {
  assert.equal(
    bypassesProxy(new URL('https://anywhere.example/'), '*'),
    true,
  );
  assert.equal(
    bypassesProxy(new URL('https://10.1.2.3/'), '10.*;localhost'),
    true,
  );
  assert.equal(
    bypassesProxy(new URL('https://build/'), '<local>'),
    true,
  );
  assert.equal(
    bypassesProxy(new URL('https://build.example.com/'), '<local>'),
    false,
  );
  assert.equal(
    bypassesProxy(new URL('https://sub.example.com/'), '*.example.com'),
    true,
  );
});

test('normalizes proxy values and rejects unsupported schemes', () => {
  assert.equal(
    normalizeProxy('127.0.0.1:7890'),
    'http://127.0.0.1:7890/',
  );
  assert.equal(
    normalizeProxy('https://proxy.example:8443'),
    'https://proxy.example:8443/',
  );
  assert.equal(normalizeProxy('socks5://127.0.0.1:7890'), null);
  assert.equal(normalizeProxy('not a url'), null);
});

test('parses and applies Windows Internet Settings', () => {
  const settings = parseWindowsProxySettings(`

HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    127.0.0.1:7890
    ProxyOverride    REG_SZ    <local>;127.*;10.*
`);
  assert.equal(settings.ProxyEnable, '0x1');
  assert.equal(
    proxyFromWindowsSettings(new URL('https://github.com/file'), settings),
    'http://127.0.0.1:7890/',
  );
  assert.equal(
    proxyFromWindowsSettings(new URL('https://10.0.0.1/file'), settings),
    null,
  );

  const disabled = { ProxyEnable: '0x0', ProxyServer: '127.0.0.1:7890' };
  assert.equal(
    proxyFromWindowsSettings(new URL('https://github.com/file'), disabled),
    null,
  );

  const perScheme = {
    ProxyEnable: '0x1',
    ProxyServer: 'http=127.0.0.1:1111;https=127.0.0.1:2222',
  };
  assert.equal(
    proxyFromWindowsSettings(new URL('https://github.com/file'), perScheme),
    'http://127.0.0.1:2222/',
  );
  assert.equal(
    proxyFromWindowsSettings(new URL('http://github.com/file'), perScheme),
    'http://127.0.0.1:1111/',
  );
});

test('environment variables take precedence over Windows settings', () => {
  assert.equal(
    resolveProxy('https://github.com/file', {
      ...windows,
      env: { HTTPS_PROXY: 'http://env.example:8080' },
    }),
    'http://env.example:8080/',
  );
});

test('hides proxy passwords when logging', () => {
  assert.equal(
    redactProxy('http://user:secret@proxy.example:8080/'),
    'http://user:***@proxy.example:8080/',
  );
  assert.equal(
    redactProxy('http://proxy.example:8080/'),
    'http://proxy.example:8080/',
  );
});

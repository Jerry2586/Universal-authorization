import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { browserLicenseRuntime, createBrowserLicenseRuntime } from '../apps/build-worker/src/runtime.js';
import { verifyActivation } from '../packages/appgog-sdk/src/verifier.js';
import { signCompactToken } from '../packages/core/src/signing.js';

const FIXED_NOW = Date.parse('2026-09-22T12:00:00.000Z');

function publicKeyDer(key) {
  return key.export({ type: 'spki', format: 'der' }).toString('base64');
}

function activation(privateKey, overrides = {}) {
  return signCompactToken({
    typ: 'activation', product: 'appgog', build_id: 'bld_runtime', package_id: 'pkg_runtime',
    domain: 'demo.example.com', backend_origin: 'https://demo.example.com',
    installation_id: 'installation_runtime_123', iat: Math.floor(FIXED_NOW / 1000) - 3600,
    exp: Math.floor(FIXED_NOW / 1000) - 60,
    offline_until: Math.floor(FIXED_NOW / 1000) + 3600,
    ...overrides,
  }, privateKey);
}

function packageManifest(privateKey, overrides = {}) {
  return signCompactToken({
    typ: 'package-manifest', product: 'appgog', build_id: 'bld_runtime', package_id: 'pkg_runtime',
    version: '1.17.1', domain: 'demo.example.com', iat: Math.floor(FIXED_NOW / 1000) - 3600,
    ...overrides,
  }, privateKey);
}

function elementText(element) {
  return [element?.textContent || '', ...(element?.children || []).map(elementText)].join(' ');
}

function fakeElement(tagName) {
  return {
    tagName, id: '', textContent: '', style: { cssText: '' }, children: [], value: '',
    append(...children) { this.children.push(...children); },
    setAttribute() {}, addEventListener(type, listener) { this[`on${type}`] = listener; },
    remove() { this.removed = true; },
  };
}

function installBrowser({
  token, fetchImpl, publicKey, packagePublicKey = publicKey, notificationPublicKey = publicKey,
  manifestToken, bridge = null, initialValues = null, referrer = '',
}) {
  const original = {
    document: globalThis.document, localStorage: globalThis.localStorage,
    location: globalThis.location, fetch: globalThis.fetch, DateNow: Date.now, setInterval: globalThis.setInterval,
  };
  const values = initialValues ?? new Map([
    ['appgog_install_appgog', 'installation_runtime_123'],
    ['appgog_license_pkg_runtime', JSON.stringify({
      activation_id: 'act_runtime', activation_token: token, refresh_secret: 'refresh_runtime',
      backend_origin: 'https://demo.example.com',
    })],
  ]);
  const intervals = [];
  globalThis.setInterval = (...args) => { const timer = original.setInterval(...args); intervals.push(timer); return timer; };
  const elements = [];
  const classes = new Set();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
  globalThis.location = {
    hostname: 'demo.example.com', origin: 'https://demo.example.com', href: 'https://demo.example.com/', reload() {},
  };
  globalThis.document = {
    readyState: 'complete', referrer,
    documentElement: { classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) } },
    head: { append: (...nodes) => elements.push(...nodes) },
    body: { append: (...nodes) => elements.push(...nodes) },
    createElement: fakeElement,
    getElementById: (id) => elements.find((element) => element.id === id && !element.removed) ?? null,
  };
  globalThis.fetch = fetchImpl;
  Date.now = () => FIXED_NOW;
  browserLicenseRuntime({
    p: 'appgog', v: '1.17.1', b: 'bld_runtime', i: 'pkg_runtime',
    u: 'https://license.example.com', k: publicKeyDer(publicKey),
    a: publicKeyDer(publicKey), q: publicKeyDer(packagePublicKey), n: publicKeyDer(notificationPublicKey),
    s: [], o: [], m: manifestToken, ...(bridge || {}),
  });
  return {
    values, elements, classes,
    async settle(predicate = () => globalThis.APPGOGLicense.status !== 'checking' || elements.some(element => element.id === '__appgog_gate')) {
      const deadline = performance.now() + 10000;
      while (!predicate()) {
        if (performance.now() >= deadline) throw new Error('Browser runtime did not finish within 10 seconds');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    },
    restore() {
      intervals.forEach(clearInterval); globalThis.setInterval = original.setInterval;
      globalThis.document = original.document;
      globalThis.localStorage = original.localStorage; globalThis.location = original.location;
      globalThis.fetch = original.fetch; Date.now = original.DateNow;
      delete globalThis.APPGOGLicense;
    },
  };
}

test('SDK 仅在显式开启时接受服务端签名的 offline_until', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const token = activation(privateKey);
  const input = {
    token, publicKey, domain: 'demo.example.com', backendUrl: 'https://demo.example.com',
    installationId: 'installation_runtime_123', buildId: 'bld_runtime', packageId: 'pkg_runtime',
    now: new Date(FIXED_NOW),
  };
  assert.throws(() => verifyActivation(input), (error) => error.code === 'TOKEN_EXPIRED');
  assert.equal(verifyActivation({ ...input, allowOffline: true }).offline_until, Math.floor(FIXED_NOW / 1000) + 3600);
  assert.throws(
    () => verifyActivation({ ...input, token: activation(privateKey, { offline_until: Math.floor(FIXED_NOW / 1000) - 1 }), allowOffline: true }),
    (error) => error.code === 'TOKEN_EXPIRED',
  );
});

test('安装域名与签名包域名不一致时显示明确换绑提示', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const browser = installBrowser({
    token: activation(privateKey),
    publicKey,
    manifestToken: packageManifest(privateKey, { domain: 'baidu.com' }),
    fetchImpl: async () => { throw new Error('domain mismatch must fail before network requests'); },
  });
  try {
    await browser.settle();
    const gate = browser.elements.find((element) => element.id === '__appgog_gate');
    assert.match(elementText(gate), /APPGOG 授权域名不匹配/);
    assert.match(elementText(gate), /当前安装域名 demo\.example\.com 与打包绑定域名 baidu\.com 不一致/);
  } finally { browser.restore(); }
});

test('网络失败时在签名离线期限内放行并显示离线提示', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const browser = installBrowser({ token: activation(privateKey), publicKey, manifestToken: packageManifest(privateKey), fetchImpl: async () => { throw new Error('offline'); } });
  try {
    await browser.settle();
    assert.equal(browser.classes.has('__appgog_locked'), false);
    assert.equal(globalThis.APPGOGLicense.status, 'offline');
    assert.ok(browser.elements.some((element) => element.id === '__appgog_offline'));
  } finally { browser.restore(); }
});

test('明确 4xx 拒绝会锁定且清除缓存凭证，不进入离线宽限', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const browser = installBrowser({
    token: activation(privateKey), publicKey, manifestToken: packageManifest(privateKey),
    fetchImpl: async () => ({ ok: false, status: 403, async json() { return { error: { message: '授权已撤销' } }; } }),
  });
  try {
    await browser.settle();
    assert.equal(browser.classes.has('__appgog_locked'), true);
    assert.ok(browser.elements.some((element) => element.id === '__appgog_gate'));
    const stored = JSON.parse(browser.values.get('appgog_license_pkg_runtime'));
    assert.equal(stored.denied, true);
    assert.equal(stored.activation_token, null);
    assert.equal(stored.refresh_secret, null);
  } finally { browser.restore(); }
});

test('成功刷新会验签并更新本地凭证', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const refreshed = activation(privateKey, {
    exp: Math.floor(FIXED_NOW / 1000) + 86400,
    offline_until: Math.floor(FIXED_NOW / 1000) + 172800,
  });
  const browser = installBrowser({
    token: activation(privateKey), publicKey, manifestToken: packageManifest(privateKey),
    fetchImpl: async (url) => {
      if (String(url).includes('/activations/refresh')) return { ok: true, status: 200, async json() { return { activation_token: refreshed }; } };
      return { ok: false, status: 404, async json() { return {}; } };
    },
  });
  try {
    await browser.settle();
    assert.equal(globalThis.APPGOGLicense.status, 'active');
    assert.equal(JSON.parse(browser.values.get('appgog_license_pkg_runtime')).activation_token, refreshed);
  } finally { browser.restore(); }
});

test('普通主题浏览器从 Xboard 服务端恢复安全状态并由桥接服务刷新授权', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const expired = activation(privateKey);
  const refreshed = activation(privateKey, {
    exp: Math.floor(FIXED_NOW / 1000) + 86400,
    offline_until: Math.floor(FIXED_NOW / 1000) + 172800,
  });
  const requests = [];
  const browser = installBrowser({
    token: expired,
    publicKey,
    manifestToken: packageManifest(privateKey),
    initialValues: new Map(),
    bridge: { gc: 'appgog_license_bridge', gv: '1.0.0', gt: 'APPGOG', j: '../appgog-license-bridge.zip', y: '00' },
    fetchImpl: async (url) => {
      const href = String(url);
      requests.push(href);
      if (href.endsWith('/health')) return { ok: true, status: 200, async json() { return {
        ok: true, code: 'appgog_license_bridge', version: '1.0.0',
        identity: { installation_id: 'installation_runtime_123', installation_public_key: 'public-key' },
      }; } };
      if (href.endsWith('/state/runtime')) return { ok: true, status: 200, async json() { return {
        state: { activation_id: 'act_runtime', activation_token: expired, backend_origin: 'https://demo.example.com' },
      }; } };
      if (href.endsWith('/refresh')) return { ok: true, status: 200, async json() { return {
        activation_id: 'act_runtime', activation_token: refreshed, backend_origin: 'https://demo.example.com',
      }; } };
      throw new Error(`unexpected request: ${href}`);
    },
  });
  try {
    await browser.settle();
    assert.equal(globalThis.APPGOGLicense.status, 'active');
    assert.equal(browser.classes.has('__appgog_locked'), false);
    const saved = JSON.parse(browser.values.get('appgog_license_pkg_runtime'));
    assert.equal(saved.activation_token, refreshed);
    assert.equal(saved.refresh_secret, undefined);
    assert.equal(saved.install_receipt_secret, undefined);
    assert.equal(saved.install_window_token, undefined);
    assert.ok(requests.some((url) => url.endsWith('/state/runtime')));
    assert.ok(requests.some((url) => url.endsWith('/refresh')));
    assert.equal(requests.some((url) => url.includes('/installation-challenges')), false);
    assert.equal(requests.some((url) => url.endsWith('/register')), false);
  } finally { browser.restore(); }
});

test('浏览器运行时只信任签名能力快照并阻止无更新权益的版本检查', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  let requests = 0;
  const browser = installBrowser({
    token: activation(privateKey, {
      capabilities: ['settings:read', 'protected:read'],
      exp: Math.floor(FIXED_NOW / 1000) + 86400,
      offline_until: Math.floor(FIXED_NOW / 1000) + 172800,
    }),
    publicKey,
    manifestToken: packageManifest(privateKey),
    fetchImpl: async () => { requests += 1; throw new Error('unexpected request'); },
  });
  try {
    await browser.settle();
    assert.equal(globalThis.APPGOGLicense.hasCapability('settings:read'), true);
    assert.equal(globalThis.APPGOGLicense.hasCapability('updates:read'), false);
    assert.throws(
      () => globalThis.APPGOGLicense.requireCapability('settings:write'),
      (error) => error.code === 'APPGOG_CAPABILITY_DENIED',
    );
    await globalThis.APPGOGLicense.checkUpdates();
    assert.equal(requests, 0);
    assert.equal(browser.elements.some((element) => element.id === '__appgog_update'), false);
  } finally { browser.restore(); }
});

test('版本通知只接受与 release_token 完全一致的签名字段', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const active = activation(privateKey, {
    exp: Math.floor(FIXED_NOW / 1000) + 86400,
    offline_until: Math.floor(FIXED_NOW / 1000) + 172800,
  });
  const releaseToken = signCompactToken({
    typ: 'release', product: 'appgog', version: '1.18.0', display_name: 'APPGOG 1.18.0',
    release_notes: 'Signed release', published_at: '2026-09-23T00:00:00.000Z',
    exp: Math.floor(FIXED_NOW / 1000) + 3600,
  }, privateKey);
  let tampered = true;
  const browser = installBrowser({
    token: active, publicKey, manifestToken: packageManifest(privateKey),
    fetchImpl: async (url) => {
      if (!String(url).includes('/releases/latest')) throw new Error('unexpected request');
      return {
        ok: true, status: 200,
        async json() {
          return {
            release_token: releaseToken,
            latest: {
              version: tampered ? '9.9.9' : '1.18.0', display_name: 'APPGOG 1.18.0',
              release_notes: 'Signed release', published_at: '2026-09-23T00:00:00.000Z',
            },
            build_center_url: 'https://build.example.com',
          };
        },
      };
    },
  });
  try {
    await browser.settle();
    assert.equal(browser.elements.some((element) => element.id === '__appgog_update'), false);
    tampered = false;
    await globalThis.APPGOGLicense.checkUpdates();
    const notice = browser.elements.find((element) => element.id === '__appgog_update');
    assert.match(notice.textContent, /1\.18\.0/);
    assert.equal(notice.children.length, 0, '未签名的打包中心 URL 不应生成跳转链接');
  } finally { browser.restore(); }
});

test('浏览器运行时分别使用 Activation、Package 和 Notification 公钥', async () => {
  const activationKeys = generateKeyPairSync('ed25519');
  const packageKeys = generateKeyPairSync('ed25519');
  const notificationKeys = generateKeyPairSync('ed25519');
  const active = activation(activationKeys.privateKey, {
    exp: Math.floor(FIXED_NOW / 1000) + 86400,
    offline_until: Math.floor(FIXED_NOW / 1000) + 172800,
  });
  const releaseToken = signCompactToken({
    typ: 'release', product: 'appgog', version: '1.18.0', display_name: 'APPGOG 1.18.0',
    release_notes: 'Separated key release', published_at: '2026-09-24T00:00:00.000Z',
    exp: Math.floor(FIXED_NOW / 1000) + 3600,
  }, notificationKeys.privateKey);
  const browser = installBrowser({
    token: active,
    publicKey: activationKeys.publicKey,
    packagePublicKey: packageKeys.publicKey,
    notificationPublicKey: notificationKeys.publicKey,
    manifestToken: packageManifest(packageKeys.privateKey),
    fetchImpl: async (url) => {
      if (!String(url).includes('/releases/latest')) throw new Error('unexpected request');
      return { ok: true, status: 200, async json() { return {
        release_token: releaseToken,
        latest: { version: '1.18.0', display_name: 'APPGOG 1.18.0', release_notes: 'Separated key release', published_at: '2026-09-24T00:00:00.000Z' },
        build_center_url: null,
      }; } };
    },
  });
  try {
    await browser.settle(() => browser.elements.some(element => element.id === '__appgog_update'));
    assert.equal(browser.classes.has('__appgog_locked'), false);
    assert.ok(browser.elements.some((element) => element.id === '__appgog_update'));
  } finally { browser.restore(); }
});

test('生成的运行时先提交一次性 Install Key，再使用 Install Receipt 与固定 Key 激活', () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const source = createBrowserLicenseRuntime({
    injection: {
      product: 'appgog', version: '1.17.1', build_id: 'bld_runtime', package_id: 'pkg_runtime',
      license_server: 'https://license.example.com', package_proof_parts: ['one', 'two'], package_proof_order: [0, 1],
    },
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
  });
  assert.match(source, /post\('\/api\/v1\/install-windows\/start'/);
  assert.match(source, /post\('\/api\/v2\/install-unlocks'/);
  assert.match(source, /install_window_id: saved\.install_window_id/);
  assert.match(source, /install_key: installInput\.value\.trim\(\)/);
  assert.match(source, /post\('\/api\/v1\/activations'/);
  assert.match(source, /license_key: fixedInput\.value\.trim\(\)/);
  assert.match(source, /install_receipt_id: saved\.install_receipt_id/);
  assert.match(source, /install_receipt_secret: saved\.install_receipt_secret/);
  assert.match(source, /XBOARD_ACCESS_TOKEN/);
  assert.match(source, /\/plugin\/upload/);
  assert.match(source, /\/plugin\/install/);
  assert.match(source, /\/plugin\/enable/);
  assert.match(source, /bridgeRequest\('\/state\/runtime'/);
  assert.match(source, /bridgeRequest\('\/refresh'/);
  assert.match(source, /activationAdminRequired/);
  assert.match(source, /await persistBridgeState\(\);[\s\S]*location\.reload\(\)/);
  assert.doesNotMatch(source, /install_key: installInput\.value\.trim\(\), license_key:/);
  assert.match(source, /result\.release_token/);
  assert.match(source, /feed\.version !== latest\.version/);
  assert.doesNotThrow(() => new Function(source));
});


for (const malformed of [false, true]) {
  test(malformed ? '授权桥上传后插件响应异常会显示可读错误并保持锁定' : '未安装授权桥时自动通过非默认管理路径上传、安装、启用并锁定等待激活', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pluginZip = Buffer.from('fixture-bridge-zip');
    const requests = [];
    let uploaded = false, installed = false, enabled = false;
    const identity = { installation_id: 'installation_runtime_123', installation_public_key: 'fixture-public-key' };
    const browser = installBrowser({
      token: null, publicKey, manifestToken: packageManifest(privateKey),
      referrer: 'https://demo.example.com/secure_test#/theme',
      initialValues: new Map([['XBOARD_ACCESS_TOKEN', JSON.stringify({ value: 'fixture-admin-token' })]]),
      bridge: { gc: 'appgog_license_bridge', gv: '1.0.0', gt: 'APPGOG', j: '/bridge.zip',
        y: createHash('sha256').update(pluginZip).digest('hex') },
      fetchImpl: async (url, options = {}) => {
        const path = new URL(url, 'https://demo.example.com').pathname;
        requests.push(path);
        if (path.endsWith('/health')) return new Response(JSON.stringify(enabled ? { ok: true, code: 'appgog_license_bridge', version: '1.0.0', identity } : {}), { status: enabled ? 200 : 404 });
        if (path === '/bridge.zip') return new Response(pluginZip);
        if (path === '/api/v2/secure_test/plugin/getPlugins') return new Response(JSON.stringify({ data: uploaded ? (malformed ? {} : [{ code: 'appgog_license_bridge', version: '1.0.0', is_installed: installed, is_enabled: enabled }]) : [] }));
        if (path === '/api/v2/secure_test/plugin/upload') {
          assert.ok(options.body instanceof FormData);
          assert.deepEqual(Buffer.from(await options.body.get('file').arrayBuffer()), pluginZip);
          uploaded = true; return new Response('{}');
        }
        if (path === '/api/v2/secure_test/plugin/install') { assert.equal(uploaded, true); installed = true; return new Response('{}'); }
        if (path === '/api/v2/secure_test/plugin/enable') { assert.equal(installed, true); enabled = true; return new Response('{}'); }
        if (path.endsWith('/register')) return new Response(JSON.stringify(identity));
        if (path.endsWith('/state/runtime') || path.endsWith('/state/read')) return new Response(JSON.stringify({ state: {} }));
        throw new Error('Unexpected bridge request: ' + path);
      },
    });
    try {
      await browser.settle();
      assert.equal(browser.classes.has('__appgog_locked'), true);
      const gate = browser.elements.find(element => element.id === '__appgog_gate');
      assert.ok(gate);
      if (malformed) {
        assert.match(elementText(gate), /插件列表响应无效/);
        assert.equal(installed, false);
      } else {
        assert.equal(enabled, true);
        assert.match(elementText(gate), /开始激活/);
        assert.deepEqual(requests.filter(path => /plugin\/(upload|install|enable)$/.test(path)), [
          '/api/v2/secure_test/plugin/upload', '/api/v2/secure_test/plugin/install', '/api/v2/secure_test/plugin/enable',
        ]);
      }
    } finally { browser.restore(); }
  });
}

for (const outdated of [false, true]) {
  test(outdated ? '健康旧授权桥自动升级后保留安装身份并等待激活' : '健康旧授权桥上传后仍未更新则保持锁定', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pluginZip = Buffer.from('fixture-bridge-zip');
    const requests = [];
    let uploaded = false, installed = true, enabled = true, healthReadsAfterUpload = 0;
    const identity = { installation_id: 'installation_runtime_123', installation_public_key: 'fixture-public-key' };
    const browser = installBrowser({
      token: null, publicKey, manifestToken: packageManifest(privateKey),
      referrer: 'https://demo.example.com/secure_test#/theme',
      initialValues: new Map([['XBOARD_ACCESS_TOKEN', JSON.stringify({ value: 'fixture-admin-token' })]]),
      bridge: { gc: 'appgog_license_bridge', gv: '1.0.1', gt: 'APPGOG', j: '/bridge.zip',
        y: createHash('sha256').update(pluginZip).digest('hex') },
      fetchImpl: async (url, options = {}) => {
        const path = new URL(url, 'https://demo.example.com').pathname;
        requests.push(path);
        if (path.endsWith('/health')) return new Response(JSON.stringify(enabled ? { ok: true, code: 'appgog_license_bridge', version: uploaded && outdated && ++healthReadsAfterUpload >= 3 ? '1.0.1' : '1.0.0', identity } : {}), { status: enabled ? 200 : 404 });
        if (path === '/bridge.zip') return new Response(pluginZip);
        if (path === '/api/v2/secure_test/plugin/getPlugins') return new Response(JSON.stringify({ data: [{ code: 'appgog_license_bridge', version: uploaded ? '1.0.1' : '1.0.0', is_installed: installed, is_enabled: enabled }] }));
        if (path === '/api/v2/secure_test/plugin/upload') {
          assert.ok(options.body instanceof FormData);
          assert.deepEqual(Buffer.from(await options.body.get('file').arrayBuffer()), pluginZip);
          uploaded = true; return new Response('{}');
        }
        if (path === '/api/v2/secure_test/plugin/install') { assert.equal(uploaded, true); installed = true; return new Response('{}'); }
        if (path === '/api/v2/secure_test/plugin/enable') { assert.equal(installed, true); enabled = true; return new Response('{}'); }
        if (path.endsWith('/register')) return new Response(JSON.stringify(identity));
        if (path.endsWith('/state/runtime') || path.endsWith('/state/read')) return new Response(JSON.stringify({ state: {} }));
        throw new Error('Unexpected bridge request: ' + path);
      },
    });
    try {
      await browser.settle();
      assert.equal(browser.classes.has('__appgog_locked'), true);
      const gate = browser.elements.find(element => element.id === '__appgog_gate');
      assert.ok(gate);
      if (!outdated) {
        assert.match(elementText(gate), /授权桥版本尚未生效/);
        assert.equal(installed, true);
      } else {
        assert.equal(enabled, true);
        assert.match(elementText(gate), /开始激活/);
        assert.deepEqual(requests.filter(path => /plugin\/(upload|install|enable)$/.test(path)), [
          '/api/v2/secure_test/plugin/upload',
        ]);
      }
    } finally { browser.restore(); }
  });
}

for (const status of [429, 503]) {
  test('授权桥 HTTP ' + status + ' 不误判缺失或重装', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const requests = [];
    const browser = installBrowser({
      token: null, publicKey, manifestToken: packageManifest(privateKey),
      bridge: { gc: 'appgog_license_bridge', gv: '1.0.2' },
      initialValues: new Map([['XBOARD_ACCESS_TOKEN', JSON.stringify({ value: 'fixture-admin-token' })]]),
      fetchImpl: async url => { requests.push(new URL(url).pathname); return new Response('{}', { status }); },
    });
    try {
      await browser.settle();
      assert.deepEqual(requests, ['/api/v1/appgog-license-bridge/health']);
      assert.equal(browser.classes.has('__appgog_locked'), true);
      assert.match(elementText(browser.elements.find(e => e.id === '__appgog_gate')), /稍后刷新重试/);
    } finally { browser.restore(); }
  });
}

test('安装解锁和固定 Key 激活保留后台路径、安装身份及窗口，激活后清理浏览器敏感字段', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const key = 'appgog_license_pkg_runtime';
  const initial = { install_window_id: 'window-real', install_window_token: 'window-proof',
    install_window_expires_at: new Date(FIXED_NOW + 3600000).toISOString(),
    installation_id: 'installation_runtime_123', xboard_admin_path: 'secure_test' };
  const values = new Map([[key, JSON.stringify(initial)], ['XBOARD_ACCESS_TOKEN', JSON.stringify({value:'fixture-admin-token'})]]);
  const writes = [];
  const identity = { installation_id: 'installation_runtime_123', installation_public_key: 'fixture-public-key' };
  let serverState = { ...initial };
  const fetchImpl = async (url, options={}) => {
    const path = new URL(url, 'https://demo.example.com').pathname;
    if (path.endsWith('/health')) return Response.json({ok:true,code:'appgog_license_bridge',version:'1.0.2',identity});
    if (path === '/api/v2/secure_test/plugin/getPlugins') return Response.json({data:[]});
    if (path.endsWith('/register')) return Response.json(identity);
    if (path.endsWith('/state/runtime') || path.endsWith('/state/read')) return Response.json({state:serverState});
    if (path.endsWith('/state/write')) { const state = JSON.parse(options.body).state; writes.push(state); serverState={...serverState,...state}; return Response.json({saved:true}); }
    if (path === '/api/v2/install-unlocks') return Response.json({install_receipt_id:'receipt',install_receipt_secret:'receipt-secret'});
    if (path === '/api/v1/installation-challenges') return Response.json({challenge_id:'challenge'});
    if (path.endsWith('/sign-challenge')) return Response.json({installation_public_key:identity.installation_public_key,challenge_id:'challenge',challenge_signature:'signature'});
    if (path === '/api/v1/activations') return Response.json({activation_id:'activation',activation_token:activation(privateKey,{exp:Math.floor(FIXED_NOW/1000)+3600}),refresh_secret:'refresh-secret'});
    throw new Error('Unexpected request '+path);
  };
  const boot = () => installBrowser({token:null,publicKey,manifestToken:packageManifest(privateKey),initialValues:values,
    bridge:{gc:'appgog_license_bridge',gv:'1.0.2',gt:'APPGOG'},fetchImpl});
  const descend = element => [element,...(element.children||[]).flatMap(descend)];
  let browser = boot();
  try {
    await browser.settle();
    let nodes = descend(browser.elements.find(e=>e.id==='__appgog_gate'));
    nodes.find(e=>e.placeholder==='INS-XXXX-XXXX-XXXX').value='fixture-install-key';
    nodes.find(e=>e.type==='url').value='https://demo.example.com/secure_test';
    await nodes.find(e=>e.tagName==='form').onsubmit({preventDefault(){}});
    const receiptState = JSON.parse(values.get(key));
    for (const field of Object.keys(initial)) assert.equal(receiptState[field],initial[field]);
    assert.equal(receiptState.install_receipt_id,'receipt');
    assert.equal(writes.at(-1).install_window_token,'window-proof');
  } finally { browser.restore(); }
  browser=boot();
  try {
    await browser.settle();
    const nodes=descend(browser.elements.find(e=>e.id==='__appgog_gate'));
    nodes.find(e=>e.placeholder==='APPGOG-XXXX-XXXX-XXXX-XXXX').value='fixture-license-key';
    await nodes.find(e=>e.tagName==='form').onsubmit({preventDefault(){}});
    const activated=JSON.parse(values.get(key));
    assert.equal(activated.activation_id,'activation');
    assert.equal(activated.xboard_admin_path,'secure_test');
    assert.equal(activated.installation_id,initial.installation_id);
    for(const field of ['install_window_token','install_receipt_secret','refresh_secret']) assert.equal(activated[field],undefined);
    assert.equal(serverState.refresh_secret,'refresh-secret');
    assert.equal(serverState.install_window_token,'window-proof');
  } finally { browser.restore(); }
});

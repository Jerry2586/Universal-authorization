import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
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

function packageManifest(privateKey) {
  return signCompactToken({
    typ: 'package-manifest', product: 'appgog', build_id: 'bld_runtime', package_id: 'pkg_runtime',
    version: '1.17.1', domain: 'demo.example.com', iat: Math.floor(FIXED_NOW / 1000) - 3600,
  }, privateKey);
}

function fakeElement(tagName) {
  return {
    tagName, id: '', textContent: '', style: { cssText: '' }, children: [], value: '',
    append(...children) { this.children.push(...children); },
    setAttribute() {}, addEventListener(type, listener) { this[`on${type}`] = listener; },
    remove() { this.removed = true; },
  };
}

function installBrowser({ token, fetchImpl, publicKey, manifestToken }) {
  const original = {
    document: globalThis.document, localStorage: globalThis.localStorage,
    location: globalThis.location, fetch: globalThis.fetch, DateNow: Date.now,
  };
  const values = new Map([
    ['appgog_install_appgog', 'installation_runtime_123'],
    ['appgog_license_pkg_runtime', JSON.stringify({
      activation_id: 'act_runtime', activation_token: token, refresh_secret: 'refresh_runtime',
      backend_origin: 'https://demo.example.com',
    })],
  ]);
  const elements = [];
  const classes = new Set();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
  globalThis.location = {
    hostname: 'demo.example.com', origin: 'https://demo.example.com', reload() {},
  };
  globalThis.document = {
    readyState: 'complete',
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
    u: 'https://license.example.com', k: publicKeyDer(publicKey), s: [], o: [], m: manifestToken,
  });
  return {
    values, elements, classes,
    async settle() { await new Promise((resolve) => setTimeout(resolve, 30)); },
    restore() {
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

test('生成的运行时先提交一次性 Install Key，再使用 Install Receipt 与固定 Key 激活', () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const source = createBrowserLicenseRuntime({
    injection: {
      product: 'appgog', version: '1.17.1', build_id: 'bld_runtime', package_id: 'pkg_runtime',
      license_server: 'https://license.example.com', package_proof_parts: ['one', 'two'], package_proof_order: [0, 1],
    },
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
  });
  assert.match(source, /post\('\/api\/v1\/install-unlocks'/);
  assert.match(source, /install_key: installInput\.value\.trim\(\)/);
  assert.match(source, /post\('\/api\/v1\/activations'/);
  assert.match(source, /license_key: fixedInput\.value\.trim\(\)/);
  assert.match(source, /install_receipt_id: saved\.install_receipt_id/);
  assert.match(source, /install_receipt_secret: saved\.install_receipt_secret/);
  assert.doesNotMatch(source, /install_key: installInput\.value\.trim\(\), license_key:/);
  assert.match(source, /result\.release_token/);
  assert.match(source, /feed\.version !== latest\.version/);
  assert.doesNotThrow(() => new Function(source));
});

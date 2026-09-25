import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { hasCapability, requireActivation, requireCapability } from '../packages/appgog-sdk/src/guard.js';
import { signCompactToken } from '../packages/core/src/signing.js';

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const now = new Date('2026-09-23T08:00:00.000Z');
  const payload = {
    typ: 'activation', product: 'appgog', domain: 'guard.example.com',
    backend_origin: 'https://panel.example.com', installation_id: 'installation_guard_123',
    build_id: 'bld_guard', package_id: 'pkg_guard',
    capabilities: ['settings:read', 'settings:write'],
    exp: Math.floor(now.getTime() / 1000) + 3600,
    offline_until: Math.floor(now.getTime() / 1000) + 7200,
  };
  return { publicKey, token: signCompactToken(payload, privateKey), now };
}

test('服务端授权守卫拒绝未激活、错误环境和缺少能力的请求', () => {
  const app = fixture();
  const base = {
    publicKey: app.publicKey, domain: 'guard.example.com', backendUrl: 'https://panel.example.com',
    installationId: 'installation_guard_123', buildId: 'bld_guard', packageId: 'pkg_guard', now: app.now,
  };
  assert.throws(() => requireActivation(base), (error) => error.code === 'APPGOG_NOT_ACTIVATED');
  assert.throws(() => requireActivation({ ...base, token: app.token, domain: 'other.example.com' }), (error) => error.code === 'DOMAIN_MISMATCH');
  assert.throws(() => requireActivation({ ...base, token: app.token, capability: 'theme:enable' }), (error) => error.code === 'APPGOG_CAPABILITY_DENIED');
  const payload = requireActivation({ ...base, headers: { authorization: `Bearer ${app.token}` }, capability: 'settings:write' });
  assert.equal(payload.package_id, 'pkg_guard');
  assert.equal(hasCapability(payload, 'settings:read'), true);
  assert.equal(hasCapability(payload, 'theme:enable'), false);
  assert.throws(() => requireCapability(payload, 'theme:enable'), (error) => error.code === 'APPGOG_CAPABILITY_DENIED');
});

test('旧版已签名激活凭证未携带 capabilities 时保持历史兼容能力', () => {
  assert.equal(hasCapability({ typ: 'activation' }, 'settings:write'), true);
  assert.equal(hasCapability({ typ: 'activation', capabilities: [] }, 'settings:write'), false);
});

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { bootstrap } from '../apps/license-api/src/bootstrap.js';
import { openDatabase } from '../apps/license-api/src/database.js';
import { createHttpHandler } from '../apps/license-api/src/http.js';
import { createBuildCenterHandler } from '../apps/build-center/src/server.js';
import { writeZip } from '../packages/core/src/zip.js';
import { PACKAGE_VERSION } from '../packages/core/src/version.js';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'appgog-http-contract-'));
  const database = openDatabase(':memory:');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const config = {
    surface: 'license-center', internalServiceToken: 'isolated-internal-token-longer-than-32-characters',
    pepper: 'isolated-pepper-longer-than-32-characters',
    sessionSecret: 'isolated-session-secret-longer-than-32-characters',
    deliveryEncryptionKey: 'isolated-encryption-key-longer-than-32-characters',
    adminToken: 'isolated-admin-token-longer-than-32-characters',
    workerToken: 'isolated-worker-token-longer-than-32-characters',
    adminUsername: 'admin', adminPassword: 'test-password-for-admin',
    publicBaseUrl: 'http://127.0.0.1:8787', webSessionTtlSeconds: 28800,
    activationTokenTtlSeconds: 604800, buildTicketTtlSeconds: 900,
    artifactRoot: join(root, 'artifacts'), uploadRoot: join(root, 'uploads'),
    updateControlPath: join(root, 'update-control'), maxSourceUploadBytes: 1024 * 1024,
  };
  const app = bootstrap({ database, config, privateKey, publicKey: pem });
  const center = createServer(createHttpHandler({ ...app, config, publicKey: pem }));
  center.listen(0, '127.0.0.1');
  await once(center, 'listening');
  const base = `http://127.0.0.1:${center.address().port}`;
  const proxy = createServer(createBuildCenterHandler({ internalUrl: base, internalToken: config.internalServiceToken }));
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const build = `http://127.0.0.1:${proxy.address().port}`;
  t.after(async () => {
    await new Promise(resolve => proxy.close(resolve));
    await new Promise(resolve => center.close(resolve));
    database.close(); rmSync(root, { recursive: true, force: true });
  });
  let sequence = 0;
  async function send(path, { actor, body, raw, method = body !== undefined || raw !== undefined ? 'POST' : 'GET', status = 200, contentType = 'text/plain', target = path.includes('/customer/') || actor?.kind === 'customer' ? build : base, token } = {}) {
    const requestId = `interface-contract-${++sequence}`;
    const response = await fetch(target + path, { method, headers: {
      'x-request-id': requestId,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(raw !== undefined ? { 'content-type': contentType } : {}),
      ...(actor ? { cookie: actor.cookie, 'x-csrf-token': actor.csrf } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    }, ...(body !== undefined ? { body: JSON.stringify(body) } : raw !== undefined ? { body: raw } : {}) });
    const text = await response.text();
    const json = response.headers.get('content-type')?.includes('application/json');
    const data = json ? JSON.parse(text) : text;
    assert.equal(response.status, status, `${method} ${path}: ${text}`);
    assert.equal(response.headers.get('x-request-id'), requestId);
    assert.equal(response.headers.get('x-appgog-version'), PACKAGE_VERSION);
    if (status >= 400) {
      assert.equal(data.error.request_id, requestId);
      assert.ok(data.error.code && data.error.message);
    }
    return { data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  async function login(kind, body) {
    const result = await send(`/web/${kind}/login`, { body });
    return { kind, cookie: result.cookie, csrf: result.data.csrf_token };
  }
  const admin = await login('admin', { username: 'admin', password: config.adminPassword });
  return { config, send, login, admin, base, build };
}

test('HTTP contracts: operations, admin lifecycle, license key rotation and revocation', async t => {
  const { send, login, admin, config } = await fixture(t);
  const post = (path, body, status = 200) => send(path, { actor: admin, body, status });
  const cms = await post('/web/admin/cms/settings', { platform_name: 'HTTP contract platform', domain_migration_cooldown_hours: 0 });
  assert.equal(cms.data.platform_name, 'HTTP contract platform');
  const branding = await send('/web/branding', { status: 200 });
  assert.equal(branding.data.platform_name, 'HTTP contract platform');
  const announcement = await post('/web/admin/announcement', { title: 'Notice', body: 'Contract verified', enabled: true });
  assert.equal(announcement.data.announcement_enabled, true);
  const node = (await post('/web/admin/cms/nodes', { name: 'Contract worker', role: 'worker' }, 201)).data;
  assert.ok(node.node_credential);
  const rotatedNode = (await post(`/web/admin/cms/nodes/${node.id}/rotate`, {})).data;
  assert.notEqual(rotatedNode.node_credential, node.node_credential);
  assert.equal((await post(`/web/admin/cms/nodes/${node.id}/status`, { status: 'disabled' })).data.status, 'disabled');
  const account = (await post('/web/admin/admins', { username: 'operator', password: '123456', role: 'license_ops' }, 201)).data;
  const operator = await login('admin', { username: 'operator', password: '123456' });
  await send('/web/admin/cms/settings', { actor: operator, body: { platform_name: 'Forbidden' }, status: 403 });
  await post(`/web/admin/admins/${account.id}/status`, { status: 'suspended' });
  await send('/web/session?actor=admin', { actor: operator, status: 401 });
  await post(`/web/admin/admins/${account.id}/status`, { status: 'active' });
  await send(`/web/admin/admins/${account.id}`, { actor: admin, method: 'DELETE' });
  const issued = (await post('/web/admin/licenses', { customer_ref: 'HTTP-contract' }, 201)).data;
  const id = issued.license_id;
  assert.equal((await post(`/web/admin/licenses/${id}/key`, {})).data.license_key, issued.license_key);
  const customer = await login('customer', { license_key: issued.license_key });
  await send('/web/customer/domain/bind', { actor: customer, body: { domain: 'contract.example.com' } });
  await post(`/web/admin/licenses/${id}/domain`, { domain: 'changed.example.com' });
  await post(`/web/admin/licenses/${id}/plan`, { plan_code: 'paid' });
  const rotated = (await post(`/web/admin/licenses/${id}/rotate-key`, {})).data;
  assert.notEqual(rotated.license_key, issued.license_key);
  await send('/web/customer/login', { body: { license_key: issued.license_key }, status: 401 });
  await login('customer', { license_key: rotated.license_key });
  await post(`/web/admin/licenses/${id}/status`, { status: 'suspended' });
  await send('/web/customer/login', { body: { license_key: rotated.license_key }, status: 401 });
  await post(`/web/admin/licenses/${id}/status`, { status: 'active' });
  assert.ok((await send(`/web/admin/licenses/${id}/events`, { actor: admin })).data.events.length);
  const apiLicense = (await send('/api/v1/admin/licenses', { token: config.adminToken, body: { customer_ref: 'API-contract' }, status: 201 })).data;
  await send(`/api/v1/admin/licenses/${apiLicense.license_id}/rotate-key`, { token: config.adminToken, body: {} });
  await send(`/web/admin/licenses/${id}`, { actor: admin, method: 'DELETE', body: { confirmation: `DELETE ${id}` } });
  await post('/web/admin/erasure-cleanup/retry', {});
  await post('/web/admin/account/password', { current_password: config.adminPassword, new_password: '654321', confirm_password: '654321' });
  await send('/web/session?actor=admin', { actor: admin, status: 401 });
  const renewed = await login('admin', { username: 'admin', password: '654321' });
  await send('/web/logout?actor=admin', { actor: renewed, body: {} });
  await send('/web/session?actor=admin', { actor: renewed, status: 401 });
});

test('HTTP contracts: support roundtrip through standalone proxy preserves attachment privacy', async t => {
  const { send, login, admin } = await fixture(t);
  const issued = (await send('/web/admin/licenses', { actor: admin, body: { customer_ref: 'support-contract' }, status: 201 })).data;
  const customer = await login('customer', { license_key: issued.license_key });
  const ticket = (await send('/web/customer/tickets', { actor: customer, body: { category: 'build', subject: 'Build question', body: 'Please inspect the package' }, status: 201 })).data;
  const customerPath = `/web/customer/tickets/${ticket.id}`;
  const adminPath = `/web/admin/tickets/${ticket.id}`;
  await send(`${customerPath}/messages`, { actor: customer, body: { body: 'Additional information' }, status: 201 });
  await send(`${adminPath}/messages`, { actor: admin, body: { body: 'Private diagnosis', visibility: 'internal' }, status: 201 });
  await send(`${adminPath}/messages`, { actor: admin, body: { body: 'Public reply', visibility: 'public' }, status: 201 });
  const attachment = (await send(`${customerPath}/attachments?filename=report.txt`, { actor: customer, raw: 'customer attachment', status: 201 })).data;
  assert.equal((await send(`${adminPath}/attachments/${attachment.id}`, { actor: admin })).data, 'customer attachment');
  assert.equal((await send(`${customerPath}/attachments/${attachment.id}`, { actor: customer })).data, 'customer attachment');
  const internal = (await send(`${adminPath}/attachments?filename=private.txt&visibility=internal`, { actor: admin, raw: 'internal attachment', status: 201 })).data;
  await send(`${customerPath}/attachments/${internal.id}`, { actor: customer, status: 404 });
  const customerView = (await send(customerPath, { actor: customer })).data;
  assert.ok(customerView.messages.some(message => message.body === 'Public reply'));
  assert.ok(!customerView.messages.some(message => message.body === 'Private diagnosis'));
  assert.ok(!customerView.attachments.some(file => file.id === internal.id));
  const adminView = (await send(adminPath, { actor: admin })).data;
  assert.ok(adminView.messages.some(message => message.body === 'Private diagnosis'));
  await send(`${adminPath}/update`, { actor: admin, body: { status: 'processing', priority: 'high' } });
  assert.equal((await send(`${customerPath}/close`, { actor: customer, body: { reason: 'Issue resolved' } })).data.status, 'closed');
  await send('/web/logout?actor=customer', { actor: customer, body: {} });
  await send('/web/session?actor=customer', { actor: customer, status: 401 });
});

test('HTTP contracts: maintenance controls enqueue only in isolated filesystem', async t => {
  const { send, admin, config } = await fixture(t);
  const unavailable = (await send('/web/admin/system/update', { actor: admin })).data;
  assert.equal(unavailable.available, false);
  await send('/web/admin/system/update', { actor: admin, body: { action: 'check-update' }, status: 503 });
  writeFileSync(join(config.updateControlPath, 'status.json'), JSON.stringify({ state: 'idle', heartbeat_at: new Date().toISOString() }));
  await send('/web/admin/system/update', { actor: admin, body: { action: 'check-update' }, status: 202 });
  assert.equal(readdirSync(join(config.updateControlPath, 'requests')).length, 1);
  await send('/web/admin/system/update', { actor: admin, body: { action: 'check-update' }, status: 409 });
  await send('/web/admin/system/migrations', { actor: admin });
  const receiver = (await send('/web/admin/system/migrations/receiver', { actor: admin, body: {}, status: 201 })).data;
  assert.ok(receiver.pairing_code);
  await send('/web/admin/system/migrations/receiver/close', { actor: admin, body: {} });
  const version = (await send('/web/admin/versions', { actor: admin, body: { version: '0.0.1', display_name: 'Contract source' }, status: 201 })).data;
  assert.equal(version.status, 'draft');
  const zip = writeZip(new Map([['config.json', Buffer.from('{"name":"APPGOG"}')], ['index.html', Buffer.from('<html><head></head><body>Contract</body></html>')]]));
  const published = await send('/web/admin/versions/upload?version=0.0.1', { actor: admin, raw: zip, contentType: 'application/zip', status: 201 });
  assert.equal(published.data.id, version.id);
  assert.equal((await send(`/web/admin/versions/${version.id}/withdraw`, { actor: admin, body: { reason: 'Withdraw isolated test source' } })).data.status, 'withdrawn');
});

test('HTTP contracts: public build authorization, unlock, activation and refresh issue verifiable tokens', async t => {
  const { send, admin, config } = await fixture(t);
  const license = (await send('/web/admin/licenses', { actor: admin, body: { customer_ref: 'activation-contract', domain: 'activate.example.com' }, status: 201 })).data;
  const ticket = (await send('/api/v1/builds/authorize', { body: { license_key: license.license_key, version: '1.0.0', domain: 'activate.example.com' }, status: 201 })).data;
  const build = (await send('/api/v1/worker/builds/claim', { token: config.workerToken, body: { build_ticket: ticket.build_ticket }, status: 201 })).data;
  const identity = { build_id: build.build_id, package_proof: build.package_secret, domain: 'activate.example.com', backend_url: 'https://panel.example.com', installation_id: 'installation_http_contract_1' };
  const receipt = (await send('/api/v1/install-unlocks', { body: { ...identity, install_key: build.install_key }, status: 201 })).data;
  const activation = (await send('/api/v1/activations', { body: { ...identity, ...receipt, license_key: license.license_key }, status: 201 })).data;
  const refreshed = (await send('/api/v1/activations/refresh', { body: { ...identity, activation_id: activation.activation_id, refresh_secret: activation.refresh_secret } })).data;
  const keys = (await send('/api/v1/public-key')).data;
  const { verifyActivation } = await import('../packages/appgog-sdk/src/verifier.js');
  for (const token of [activation.activation_token, refreshed.activation_token]) {
    const claims = verifyActivation({ token, publicKey: keys.public_keys.activation, domain: identity.domain, backendUrl: identity.backend_url, installationId: identity.installation_id });
    assert.equal(claims.package_id, build.package_id);
  }
  await send('/api/v1/releases/latest?product=appgog');
  await send('/api/v1/releases/latest?product=unknown', { status: 404 });
});


test('浏览器跨域两阶段激活预检放行，管理接口不开放跨域', async t => {
  const { base } = await fixture(t);
  for (const path of ['/api/v1/install-windows/start', '/api/v1/install-windows/expire', '/api/v2/install-unlocks', '/api/v1/installation-challenges', '/api/v1/activations']) {
    const response = await fetch(base + path, { method: 'OPTIONS', headers: {
      origin: 'https://customer.example.com', 'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    } });
    assert.equal(response.status, 204, path);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://customer.example.com');
    assert.match(response.headers.get('access-control-allow-headers'), /content-type/);
  }
  const rejected = await fetch(base + '/web/admin/licenses', { method: 'OPTIONS', headers: { origin: 'https://customer.example.com' } });
  assert.equal(rejected.headers.get('access-control-allow-origin'), null);
});

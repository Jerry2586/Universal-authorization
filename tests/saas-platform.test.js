import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { bootstrap } from '../apps/license-api/src/bootstrap.js';
import { openDatabase } from '../apps/license-api/src/database.js';
import { createHttpHandler } from '../apps/license-api/src/http.js';
import { createBuildCenterHandler } from '../apps/build-center/src/server.js';
import { writeZip } from '../packages/core/src/zip.js';
import { verifyCompactToken } from '../packages/core/src/signing.js';

async function fixture(t, initialTime = '2026-09-22T08:00:00.000Z', surface = 'combined') {
  const database = openDatabase(':memory:');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const root = mkdtempSync(join(tmpdir(), 'appgog-saas-test-'));
  let now = new Date(initialTime);
  const config = {
    pepper: 'saas-test-pepper-longer-than-thirty-two-characters',
    sessionSecret: 'saas-test-session-secret-longer-than-thirty-two',
    deliveryEncryptionKey: 'saas-test-delivery-key-longer-than-thirty-two',
    adminToken: 'saas-test-admin-token-longer-than-thirty-two',
    adminUsername: 'owner', adminPassword: 'owner-password-for-saas-tests',
    workerToken: 'saas-test-worker-token-longer-than-thirty-two',
    internalServiceToken: 'saas-test-internal-token-longer-than-thirty-two',
    surface,
    publicBaseUrl: 'http://127.0.0.1:8787',
    activationTokenTtlSeconds: 604800, buildTicketTtlSeconds: 900,
    webSessionTtlSeconds: 30 * 86400, maxSourceUploadBytes: 128 * 1024 * 1024,
    artifactRoot: join(root, 'artifacts'), uploadRoot: join(root, 'uploads'),
  };
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const app = bootstrap({ database, config, privateKey, publicKey: publicKeyPem, clock: () => new Date(now) });
  const server = createServer(createHttpHandler({ ...app, config, publicKey: publicKeyPem }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function send(path, { method = 'GET', body, cookie, csrf } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, cookie: response.headers.get('set-cookie'), data: await response.json() };
  }
  async function login(path, body) {
    const response = await send(path, { method: 'POST', body });
    return { ...response, cookie: response.cookie?.split(';')[0], csrf: response.data?.csrf_token };
  }
  const owner = () => login('/web/admin/login', { username: config.adminUsername, password: config.adminPassword });
  const customer = (licenseKey) => login('/web/customer/login', { license_key: licenseKey });
  return { ...app, database, publicKey, base, config, send, owner, customer, setNow(value) { now = new Date(value); } };
}

test('admin and customer sessions coexist; build center cannot access admin session', async (t) => {
  const app = await fixture(t, '2026-09-22T08:00:00.000Z', 'license-center');
  const owner = await app.owner();
  const issued = await issue(app, owner, { domain: 'sessions.example.com' });
  const center = createServer(createBuildCenterHandler({
    internalUrl: app.base, internalToken: app.config.internalServiceToken,
  }));
  center.listen(0, '127.0.0.1');
  await once(center, 'listening');
  t.after(() => new Promise((resolve) => center.close(resolve)));
  const centerUrl = `http://127.0.0.1:${center.address().port}`;
  const loginResponse = await fetch(`${centerUrl}/web/customer/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ license_key: issued.license_key }),
  });
  assert.equal(loginResponse.status, 200);
  const customerData = await loginResponse.json();
  const customerCookie = loginResponse.headers.get('set-cookie').split(';')[0];
  assert.match(owner.cookie, /^appgog_admin_session=/);
  assert.match(customerCookie, /^appgog_customer_session=/);
  const bothCookies = `${owner.cookie}; ${customerCookie}`;
  assert.equal((await app.send('/web/session?actor=admin', { cookie: bothCookies })).data.actor, 'admin');
  const customerSession = await fetch(`${centerUrl}/web/session?actor=customer`, { headers: { cookie: bothCookies } });
  assert.equal(customerSession.status, 200);
  assert.equal((await customerSession.json()).actor, 'customer');
  assert.equal((await fetch(`${centerUrl}/web/session?actor=admin`, { headers: { cookie: bothCookies } })).status, 403);
  assert.equal((await fetch(`${centerUrl}/web/admin/overview`, { headers: { cookie: bothCookies } })).status, 404);
  assert.equal((await app.send('/web/session?actor=customer', { cookie: bothCookies })).status, 403);
  const logout = await fetch(`${centerUrl}/web/logout?actor=customer`, {
    method: 'POST', headers: { cookie: bothCookies, 'x-csrf-token': customerData.csrf_token },
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /^appgog_customer_session=/);
  assert.equal((await app.send('/web/session?actor=admin', { cookie: bothCookies })).status, 200);
});

async function issue(app, admin, { customerRef = 'ORDER-SAAS', domain = 'customer.example.com', updateUntil } = {}) {
  const result = await app.send('/web/admin/licenses', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: { customer_ref: customerRef, domain, update_until: updateUntil, max_builds_per_day: 10 },
  });
  assert.equal(result.status, 201);
  return result.data;
}

function addPublishedVersion(app, { version, publishedAt, releaseNotes = '' }) {
  const product = app.repository.productByCode('appgog');
  const zip = writeZip(new Map([
    ['APPGOG/config.json', Buffer.from(JSON.stringify({ name: 'APPGOG', version }))],
    ['APPGOG/index.html', Buffer.from('<!doctype html><html><head></head><body>APPGOG</body></html>')],
  ]));
  const ref = `sources/saas-${version}.zip`;
  app.artifactStore.put(ref, zip);
  app.database.prepare(`
    INSERT INTO source_versions (
      id, product_id, version, display_name, source_kind, source_ref, status,
      release_notes, channel, release_kind, min_xboard_version, min_upgrade_version,
      rollback_allowed, rollback_to, published_at, created_at
    ) VALUES (?, ?, ?, ?, 'official', ?, 'active', ?, 'stable', 'feature', '1.9.0', '1.4.0', 1, '1.4.2', ?, ?)
  `).run(`src_saas_${version}`, product.id, version, `APPGOG ${version}`, ref,
    releaseNotes, publishedAt, publishedAt);
}

test('owner creates a release_manager who can log in but cannot issue a license', async (t) => {
  const app = await fixture(t);
  const owner = await app.owner();
  assert.equal(owner.status, 200);
  const created = await app.send('/web/admin/admins', {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf,
    body: { username: 'release.manager', display_name: 'Release Manager',
      password: 'release-manager-password-2026', role: 'release_manager' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.role, 'release_manager');
  const manager = await app.send('/web/admin/login', {
    method: 'POST', body: { username: 'release.manager', password: 'release-manager-password-2026' },
  });
  assert.equal(manager.status, 200);
  const denied = await app.send('/web/admin/licenses', {
    method: 'POST', cookie: manager.cookie.split(';')[0], csrf: manager.data.csrf_token,
    body: { customer_ref: 'ORDER-NOT-ALLOWED', domain: 'no.example.com' },
  });
  assert.equal(denied.status, 403);
});

test('customer overview exposes key prefix and domain, not customer reference or license id', async (t) => {
  const app = await fixture(t);
  const issued = await issue(app, await app.owner(), {
    customerRef: 'PRIVATE-CUSTOMER-REFERENCE', domain: 'privacy.example.com',
  });
  const customer = await app.customer(issued.license_key);
  assert.equal(customer.status, 200);
  const overview = await app.send('/web/customer/overview', { cookie: customer.cookie });
  assert.equal(overview.status, 200);
  assert.equal(overview.data.license.key_prefix, issued.license_key.slice(0, 12));
  assert.equal(overview.data.license.bound_domain, 'privacy.example.com');
  assert.equal(Object.hasOwn(overview.data.license, 'id'), false);
  assert.equal(Object.hasOwn(overview.data.license, 'customer_ref'), false);
  assert.doesNotMatch(JSON.stringify(overview.data), /PRIVATE-CUSTOMER-REFERENCE/);
});

test('release metadata and update window allow old published builds but reject newer releases', async (t) => {
  const app = await fixture(t, '2026-09-20T08:00:00.000Z');
  addPublishedVersion(app, {
    version: '1.5.0', publishedAt: '2026-09-20T09:00:00.000Z', releaseNotes: 'Stable update',
  });
  addPublishedVersion(app, {
    version: '1.6.0', publishedAt: '2026-09-22T09:00:00.000Z', releaseNotes: 'New release',
  });
  const issued = await issue(app, await app.owner(), {
    domain: 'updates.example.com', updateUntil: '2026-09-21T23:59:59.000Z',
  });
  app.setNow('2026-09-23T08:00:00.000Z');
  const customer = await app.customer(issued.license_key);
  assert.equal(customer.status, 200);
  const overview = await app.send('/web/customer/overview', { cookie: customer.cookie });
  assert.equal(overview.status, 200);
  const version = overview.data.versions.find((item) => item.version === '1.5.0');
  assert.ok(version);
  assert.equal(version.release_notes, 'Stable update');
  assert.equal(version.channel, 'stable');
  assert.equal(version.release_kind, 'feature');
  assert.equal(version.min_xboard_version, '1.9.0');
  assert.equal(version.min_upgrade_version, '1.4.0');
  assert.equal(version.rollback_allowed, true);
  assert.equal(version.rollback_to, '1.4.2');
  assert.equal(version.published_at, '2026-09-20T09:00:00.000Z');
  const oldBuild = await app.send('/web/customer/builds', {
    method: 'POST', cookie: customer.cookie, csrf: customer.csrf,
    body: { version: '1.5.0', domain: 'updates.example.com' },
  });
  assert.equal(oldBuild.status, 201);
  const newBuild = await app.send('/web/customer/builds', {
    method: 'POST', cookie: customer.cookie, csrf: customer.csrf,
    body: { version: '1.6.0', domain: 'updates.example.com' },
  });
  assert.equal(newBuild.status, 403);
  assert.equal(newBuild.data.error.code, 'UPDATE_WINDOW_EXPIRED');
});

test('activation requires both matching fixed license Key and one-time install Key', async (t) => {
  const app = await fixture(t);
  const licensed = app.service.issueLicense({ customerRef: 'ORDER-DOUBLE-KEY', domain: 'activate.example.com' });
  const unrelated = app.service.issueLicense({ customerRef: 'ORDER-OTHER', domain: 'other.example.com' });
  function makeBuild() {
    const ticket = app.service.authorizeBuild({
      licenseKey: licensed.licenseKey, version: '1.0.0', domain: 'activate.example.com',
    });
    return app.service.claimBuild({ buildTicket: ticket.buildTicket });
  }
  function activate(build, licenseKey, installationId) {
    return app.send('/api/v1/activations', {
      method: 'POST', body: {
        ...(licenseKey === undefined ? {} : { license_key: licenseKey }),
        install_key: build.installKey, build_id: build.buildId,
        package_proof: build.packageSecret, domain: 'activate.example.com',
        backend_url: 'https://activate.example.com', installation_id: installationId,
      },
    });
  }
  const build = makeBuild();
  const missing = await activate(build, undefined, 'installation_missing_key_1');
  assert.ok(missing.status >= 400 && missing.status < 500, `missing fixed Key: ${missing.status}`);
  const wrong = await activate(build, unrelated.licenseKey, 'installation_wrong_key_2');
  assert.ok(wrong.status >= 400 && wrong.status < 500, `unrelated fixed Key: ${wrong.status}`);
  const correct = await activate(build, licensed.licenseKey, 'installation_correct_key_3');
  assert.equal(correct.status, 201);
  assert.match(correct.data.activation_token, /^[^.]+\.[^.]+\.[^.]+$/);
});

test('rollback intent and base_version persist in job and customer build list', async (t) => {
  const app = await fixture(t);
  addPublishedVersion(app, { version: '1.5.0', publishedAt: '2026-09-22T08:00:00.000Z' });
  const issued = await issue(app, await app.owner(), { domain: 'rollback.example.com' });
  const customer = await app.customer(issued.license_key);
  const queued = await app.send('/web/customer/builds', {
    method: 'POST', cookie: customer.cookie, csrf: customer.csrf,
    body: { version: '1.5.0', domain: 'rollback.example.com', intent: 'rollback', base_version: '1.6.0' },
  });
  assert.equal(queued.status, 201);
  assert.equal(queued.data.intent, 'rollback');
  assert.equal(queued.data.base_version, '1.6.0');
  const row = app.database.prepare('SELECT intent, base_version FROM build_jobs WHERE id = ?').get(queued.data.id);
  assert.equal(row.intent, 'rollback');
  assert.equal(row.base_version, '1.6.0');
  const overview = await app.send('/web/customer/overview', { cookie: customer.cookie });
  assert.equal(overview.status, 200);
  const listed = overview.data.builds.find((item) => item.id === queued.data.id);
  assert.equal(listed.intent, 'rollback');
  assert.equal(listed.base_version, '1.6.0');
});

test('管理员停用后旧会话立即失效，所有者账号受保护', async (t) => {
  const app = await fixture(t);
  const owner = await app.owner();
  const created = await app.send('/web/admin/admins', {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf,
    body: { username: 'support-qa', display_name: '客服测试', password: 'support-qa-password-2026', role: 'support' },
  });
  assert.equal(created.status, 201);
  const staff = await app.send('/web/admin/login', { method: 'POST', body: { username: 'support-qa', password: 'support-qa-password-2026' } });
  assert.equal(staff.status, 200);
  assert.equal((await app.send('/web/admin/overview', { cookie: staff.cookie.split(';')[0] })).status, 200);
  const suspended = await app.send(`/web/admin/admins/${created.data.id}/status`, {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf, body: { status: 'suspended' },
  });
  assert.equal(suspended.status, 200);
  assert.equal((await app.send('/web/admin/overview', { cookie: staff.cookie.split(';')[0] })).status, 401);
  const ownerRow = app.repository.adminByUsername('owner');
  const protectedChange = await app.send(`/web/admin/admins/${ownerRow.id}/status`, {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf, body: { status: 'suspended' },
  });
  assert.equal(protectedChange.status, 403);
});

test('版本更新公告由服务端签名，打包地址与版本字段不能被替换', async (t) => {
  const app = await fixture(t);
  addPublishedVersion(app, { version: '1.8.0', publishedAt: '2026-09-22T08:00:00.000Z', releaseNotes: '发布公告' });
  const feed = await app.send('/api/v1/releases/latest?product=appgog');
  assert.equal(feed.status, 200);
  const payload = verifyCompactToken(feed.data.release_token, app.publicKey);
  assert.equal(payload.typ, 'release');
  assert.equal(payload.version, feed.data.latest.version);
  assert.equal(payload.release_notes, feed.data.latest.release_notes);
  assert.equal(payload.build_center_url, feed.data.build_center_url);
});

test('CMS 设置和节点凭证只由所有者管理，停用与轮换会立即生效', async (t) => {
  const app = await fixture(t, '2026-09-22T08:00:00.000Z', 'license-center');
  const owner = await app.owner();
  const settings = await app.send('/web/admin/cms/settings', {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf,
    body: {
      platform_name: 'APPGOG 正式授权中心',
      license_public_url: 'https://auth.example.com/',
      build_public_url: 'https://build.example.com/build/',
      license_service_enabled: true,
      customer_login_enabled: true,
      build_center_enabled: true,
      new_builds_enabled: false,
      worker_enabled: true,
    },
  });
  assert.equal(settings.status, 200);
  assert.equal(settings.data.platform_name, 'APPGOG 正式授权中心');
  assert.equal(settings.data.license_public_url, 'https://auth.example.com');
  assert.equal(settings.data.new_builds_enabled, false);

  const invalidUrl = await app.send('/web/admin/cms/settings', {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf,
    body: { license_public_url: 'not-a-url' },
  });
  assert.equal(invalidUrl.status, 400);
  assert.equal(invalidUrl.data.error.code, 'CMS_URL_INVALID');

  const created = await app.send('/web/admin/cms/nodes', {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf,
    body: { name: '香港打包中心', role: 'build-center', public_url: 'https://build-hk.example.com/' },
  });
  assert.equal(created.status, 201);
  assert.match(created.data.node_credential, /^BLD_/);
  assert.equal(created.data.public_url, 'https://build-hk.example.com');
  const oldCredential = created.data.node_credential;
  const stored = app.database.prepare('SELECT credential_hash FROM service_nodes WHERE id = ?').get(created.data.id);
  assert.notEqual(stored.credential_hash, oldCredential);

  async function probe(credential) {
    return fetch(`${app.base}/web/customer/overview`, { headers: { authorization: `Bearer ${credential}` } });
  }
  assert.equal((await probe(oldCredential)).status, 401);
  const disabled = await app.send(`/web/admin/cms/nodes/${created.data.id}/status`, {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf, body: { status: 'disabled' },
  });
  assert.equal(disabled.status, 200);
  assert.equal((await probe(oldCredential)).status, 403);
  await app.send(`/web/admin/cms/nodes/${created.data.id}/status`, {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf, body: { status: 'active' },
  });
  const rotated = await app.send(`/web/admin/cms/nodes/${created.data.id}/rotate`, {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf, body: {},
  });
  assert.equal(rotated.status, 200);
  assert.match(rotated.data.node_credential, /^BLD_/);
  assert.notEqual(rotated.data.node_credential, oldCredential);
  assert.equal((await probe(oldCredential)).status, 403);
  assert.equal((await probe(rotated.data.node_credential)).status, 401);

  const staffCreated = await app.send('/web/admin/admins', {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf,
    body: { username: 'cms-support', display_name: 'CMS 客服', password: 'cms-support-password-2026', role: 'support' },
  });
  assert.equal(staffCreated.status, 201);
  const staff = await app.send('/web/admin/login', { method: 'POST', body: { username: 'cms-support', password: 'cms-support-password-2026' } });
  const staffOverview = await app.send('/web/admin/overview', { cookie: staff.cookie.split(';')[0] });
  assert.equal(staffOverview.status, 200);
  assert.equal(staffOverview.data.cms, null);
  const forbidden = await app.send('/web/admin/cms/settings', {
    method: 'POST', cookie: staff.cookie.split(';')[0], csrf: staff.data.csrf_token,
    body: { platform_name: '不应被保存' },
  });
  assert.equal(forbidden.status, 403);
});

test('已有 SQLite 数据库自动追加新字段并保留原管理员身份', () => {
  const root = mkdtempSync(join(tmpdir(), 'appgog-migrate-test-'));
  const path = join(root, 'legacy.sqlite');
  try {
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE admin_users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO admin_users VALUES ('adm_legacy', 'legacy-owner', 'hashed-placeholder', 'active', '2025-01-01', '2025-01-01');
    CREATE TABLE source_versions (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL, version TEXT NOT NULL,
      display_name TEXT NOT NULL, source_kind TEXT NOT NULL, source_ref TEXT,
      status TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(product_id, version)
    );
    CREATE TABLE build_jobs (
      id TEXT PRIMARY KEY, license_id TEXT NOT NULL, source_version_id TEXT,
      requested_version TEXT NOT NULL, requested_domain TEXT NOT NULL,
      source_kind TEXT NOT NULL, upload_ref TEXT, status TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0, status_message TEXT NOT NULL,
      lease_owner TEXT, lease_expires_at TEXT, build_id TEXT, artifact_ref TEXT,
      artifact_sha256 TEXT, install_key_encrypted TEXT, error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
    );`);
    old.close();
    const upgraded = openDatabase(path);
    try {
      const owner = upgraded.prepare(`SELECT username, role, is_owner FROM admin_users WHERE id = 'adm_legacy'`).get();
      assert.equal(owner.username, 'legacy-owner');
      assert.equal(owner.role, 'owner');
      assert.equal(owner.is_owner, 1);
      assert.ok(upgraded.prepare('PRAGMA table_info(source_versions)').all().some((column) => column.name === 'release_notes'));
      assert.ok(upgraded.prepare('PRAGMA table_info(build_jobs)').all().some((column) => column.name === 'intent'));
    } finally { upgraded.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

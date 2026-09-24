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
import { createRepository } from '../apps/license-api/src/repository.js';
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
    licenseEncryptionKey: 'saas-test-license-key-longer-than-thirty-two',
    adminToken: 'saas-test-admin-token-longer-than-thirty-two',
    adminUsername: 'owner', adminPassword: 'owner-password-for-saas-tests',
    workerToken: 'saas-test-worker-token-longer-than-thirty-two',
    internalServiceToken: 'saas-test-internal-token-longer-than-thirty-two',
    surface,
    publicBaseUrl: 'http://127.0.0.1:8787',
    activationTokenTtlSeconds: 604800, buildTicketTtlSeconds: 900,
    webSessionTtlSeconds: 30 * 86400, maxSourceUploadBytes: 128 * 1024 * 1024,
    artifactRoot: join(root, 'artifacts'), uploadRoot: join(root, 'uploads'),
    updateControlPath: join(root, 'update-control'),
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
      password: '183726', role: 'release_manager' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.role, 'release_manager');
  const manager = await app.send('/web/admin/login', {
    method: 'POST', body: { username: 'release.manager', password: '183726' },
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
  assert.match(overview.data.system_version, /^\d+\.\d+\.\d+$/);
  assert.equal(Object.hasOwn(overview.data.license, 'id'), false);
  assert.equal(Object.hasOwn(overview.data.license, 'customer_ref'), false);
  assert.doesNotMatch(JSON.stringify(overview.data), /PRIVATE-CUSTOMER-REFERENCE/);
});

test('客户中心可自助换绑域名，固定 Key 不变并遵守后台冷却', async (t) => {
  const app = await fixture(t);
  const owner = await app.owner();
  const issued = await issue(app, owner, { customerRef: 'ORDER-DOMAIN-FLOW', domain: null });
  const customer = await app.customer(issued.license_key);
  assert.equal(customer.status, 200);

  const initial = await app.send('/web/customer/overview', { cookie: customer.cookie });
  assert.equal(initial.data.license.bound_domain, null);
  const noCsrf = await app.send('/web/customer/domain/bind', {
    method: 'POST', cookie: customer.cookie, body: { domain: 'https://WWW.Flow.Example.com/' },
  });
  assert.equal(noCsrf.status, 403);
  const bound = await app.send('/web/customer/domain/bind', {
    method: 'POST', cookie: customer.cookie, csrf: customer.csrf,
    body: { domain: 'https://WWW.Flow.Example.com/' },
  });
  assert.equal(bound.status, 200);
  assert.equal(bound.data.bound_domain, 'flow.example.com');

  const requested = await app.send('/web/customer/domain-migrations', {
    method: 'POST', cookie: customer.cookie, csrf: customer.csrf,
    body: { domain: 'next.example.com', reason: '客户正式业务域名需要按计划完成迁移' },
  });
  assert.equal(requested.status, 201);
  assert.equal(requested.data.status, 'approved');
  assert.equal(requested.data.bound_domain, 'next.example.com');
  assert.equal(requested.data.generation, 2);
  const overview = await app.send('/web/customer/overview', { cookie: customer.cookie });
  assert.equal(overview.data.domain_migration.requested_domain, 'next.example.com');
  assert.equal(overview.data.license.bound_domain, 'next.example.com');
  const adminOverview = await app.send('/web/admin/overview', { cookie: owner.cookie });
  assert.ok(adminOverview.data.domain_migrations.some((item) => item.id === requested.data.id && item.status === 'approved'));
  const loginAgain = await app.send('/web/customer/login', { method: 'POST', body: { license_key: issued.license_key } });
  assert.equal(loginAgain.status, 200);
  const settings = await app.send('/web/admin/cms/settings', {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf,
    body: { platform_name: 'APPGOG', domain_migration_cooldown_hours: 24 },
  });
  assert.equal(settings.status, 200);
  const cooling = await app.send('/web/customer/domain-migrations', {
    method: 'POST', cookie: customer.cookie, csrf: customer.csrf,
    body: { domain: 'third.example.com', reason: '' },
  });
  assert.equal(cooling.status, 429);
  assert.equal(cooling.data.error.code, 'DOMAIN_MIGRATION_COOLDOWN');
  const adminChanged = await app.send(`/web/admin/licenses/${issued.license_id}/domain`, {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf, body: { domain: 'admin.example.com' },
  });
  assert.notEqual(adminChanged.status, 429);
});

test('release metadata hides rollback policy, historical customer builds are blocked, and update windows reject newer releases', async (t) => {
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
  assert.equal('rollback_allowed' in version, false);
  assert.equal('rollback_to' in version, false);
  assert.equal(version.published_at, '2026-09-20T09:00:00.000Z');
  const oldBuild = await app.send('/web/customer/builds', {
    method: 'POST', cookie: customer.cookie, csrf: customer.csrf,
    body: { version: '1.5.0', domain: 'updates.example.com' },
  });
  assert.equal(oldBuild.status, 409);
  assert.equal(oldBuild.data.error.code, 'HISTORICAL_BUILD_DISABLED');
  const newBuild = await app.send('/web/customer/builds', {
    method: 'POST', cookie: customer.cookie, csrf: customer.csrf,
    body: { version: '1.6.0', domain: 'updates.example.com' },
  });
  assert.equal(newBuild.status, 403);
  assert.equal(newBuild.data.error.code, 'UPDATE_WINDOW_EXPIRED');
});

test('安装解锁与正式激活必须分两次提交，禁止双 Key 一步激活', async (t) => {
  const app = await fixture(t);
  const licensed = app.service.issueLicense({ customerRef: 'ORDER-DOUBLE-KEY', domain: 'activate.example.com' });
  const unrelated = app.service.issueLicense({ customerRef: 'ORDER-OTHER', domain: 'other.example.com' });
  function makeBuild() {
    const ticket = app.service.authorizeBuild({
      licenseKey: licensed.licenseKey, version: '1.0.0', domain: 'activate.example.com',
    });
    return app.service.claimBuild({ buildTicket: ticket.buildTicket });
  }
  function unlock(build, installationId) {
    return app.send('/api/v1/install-unlocks', {
      method: 'POST', body: {
        install_key: build.installKey, build_id: build.buildId,
        package_proof: build.packageSecret, domain: 'activate.example.com',
        backend_url: 'https://activate.example.com', installation_id: installationId,
      },
    });
  }
  function activate(build, receipt, licenseKey, installationId) {
    return app.send('/api/v1/activations', {
      method: 'POST', body: {
        ...(licenseKey === undefined ? {} : { license_key: licenseKey }),
        ...(receipt ? {
          install_receipt_id: receipt.install_receipt_id,
          install_receipt_secret: receipt.install_receipt_secret,
        } : {}),
        build_id: build.buildId,
        package_proof: build.packageSecret, domain: 'activate.example.com',
        backend_url: 'https://activate.example.com', installation_id: installationId,
      },
    });
  }
  const build = makeBuild();
  const direct = await app.send('/api/v1/activations', {
    method: 'POST', body: {
      install_key: build.installKey, license_key: licensed.licenseKey,
      build_id: build.buildId, package_proof: build.packageSecret,
      domain: 'activate.example.com', backend_url: 'https://activate.example.com',
      installation_id: 'installation_direct_shortcut_1',
    },
  });
  assert.equal(direct.status, 400);
  assert.equal(direct.data.error.code, 'INSTALL_RECEIPT_REQUIRED');

  const unlocked = await unlock(build, 'installation_two_stage_2');
  assert.equal(unlocked.status, 201);
  assert.match(unlocked.data.install_receipt_id, /^irc_/);
  assert.equal(app.database.prepare('SELECT COUNT(*) AS count FROM activations').get().count, 0);

  const missing = await activate(build, unlocked.data, undefined, 'installation_two_stage_2');
  assert.equal(missing.status, 400);
  assert.equal(missing.data.error.code, 'LICENSE_KEY_REQUIRED');
  const wrong = await activate(build, unlocked.data, unrelated.licenseKey, 'installation_two_stage_2');
  assert.ok(wrong.status >= 400 && wrong.status < 500, `unrelated fixed Key: ${wrong.status}`);
  const correct = await activate(build, unlocked.data, licensed.licenseKey, 'installation_two_stage_2');
  assert.equal(correct.status, 201);
  assert.match(correct.data.activation_token, /^[^.]+\.[^.]+\.[^.]+$/);
});

test('customer build API rejects rollback intent and does not enqueue a job', async (t) => {
  const app = await fixture(t);
  addPublishedVersion(app, { version: '1.5.0', publishedAt: '2026-09-22T08:00:00.000Z' });
  const issued = await issue(app, await app.owner(), { domain: 'rollback.example.com' });
  const customer = await app.customer(issued.license_key);
  const queued = await app.send('/web/customer/builds', {
    method: 'POST', cookie: customer.cookie, csrf: customer.csrf,
    body: { version: '1.5.0', domain: 'rollback.example.com', intent: 'rollback', base_version: '1.6.0' },
  });
  assert.equal(queued.status, 400);
  assert.equal(queued.data.error.code, 'BUILD_INTENT_INVALID');
  assert.equal(app.database.prepare('SELECT COUNT(*) AS count FROM build_jobs').get().count, 0);
});

test('support tickets isolate customers, hide internal notes, and allow admin assignment and replies', async (t) => {
  const app = await fixture(t);
  const owner = await app.owner();
  const issued = await issue(app, owner, { customerRef: 'ORDER-TICKET-A', domain: 'ticket-a.example.com' });
  const otherIssued = await issue(app, owner, { customerRef: 'ORDER-TICKET-B', domain: 'ticket-b.example.com' });
  const customer = await app.customer(issued.license_key);
  const other = await app.customer(otherIssued.license_key);
  const created = await app.send('/web/customer/tickets', {
    method: 'POST', cookie: customer.cookie, csrf: customer.csrf,
    body: { category: 'build', priority: 'high', subject: '构建一直失败', body: '构建到一半后显示失败，请协助检查。' },
  });
  assert.equal(created.status, 201);
  assert.match(created.data.ticket_number, /^TK-\d{8}-[0-9A-F]{6}$/);
  assert.equal(created.data.key_prefix, undefined);
  assert.equal(created.data.license_id, undefined);
  assert.equal(JSON.stringify(created.data).includes(issued.license_key), false);
  assert.equal((await app.send(`/web/customer/tickets/${created.data.id}`, { cookie: other.cookie })).status, 404);

  const internal = await app.send(`/web/admin/tickets/${created.data.id}/messages`, {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf,
    body: { body: '内部确认 Worker 日志。', visibility: 'internal' },
  });
  assert.equal(internal.status, 201);
  const publicReply = await app.send(`/web/admin/tickets/${created.data.id}/messages`, {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf,
    body: { body: '已收到，正在检查构建节点。', visibility: 'public' },
  });
  assert.equal(publicReply.status, 201);
  const updated = await app.send(`/web/admin/tickets/${created.data.id}/update`, {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf,
    body: { status: 'processing', priority: 'urgent', assigned_admin_id: owner.data.id },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.assigned_admin_id, owner.data.id);
  const customerView = await app.send(`/web/customer/tickets/${created.data.id}`, { cookie: customer.cookie });
  assert.equal(customerView.status, 200);
  assert.equal(customerView.data.messages.some((message) => message.visibility === 'internal'), false);
  assert.equal(customerView.data.messages.some((message) => message.body.includes('正在检查')), true);
  const audit = app.repository.listAudit(20).filter((event) => event.subject_id === created.data.id);
  assert.ok(audit.some((event) => event.action === 'support_ticket.created'));
  assert.ok(audit.some((event) => event.action === 'support_ticket.noted'));
  assert.ok(audit.some((event) => event.action === 'support_ticket.updated'));
});

test('管理员停用后旧会话立即失效，所有者账号受保护', async (t) => {
  const app = await fixture(t);
  const owner = await app.owner();
  const created = await app.send('/web/admin/admins', {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf,
    body: { username: 'support-qa', display_name: '客服测试', password: '294837', role: 'support' },
  });
  assert.equal(created.status, 201);
  const staff = await app.send('/web/admin/login', { method: 'POST', body: { username: 'support-qa', password: '294837' } });
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

test('管理员可修改自己的六位数字密码，修改后所有旧会话失效', async (t) => {
  const app = await fixture(t);
  const first = await app.owner();
  const second = await app.owner();
  const changed = await app.send('/web/admin/account/password', {
    method: 'POST', cookie: first.cookie, csrf: first.csrf,
    body: { current_password: app.config.adminPassword, new_password: '516204', confirm_password: '516204' },
  });
  assert.equal(changed.status, 200);
  assert.match(changed.cookie, /^appgog_admin_session=;/);
  assert.equal((await app.send('/web/admin/overview', { cookie: first.cookie })).status, 401);
  assert.equal((await app.send('/web/admin/overview', { cookie: second.cookie })).status, 401);
  assert.equal((await app.send('/web/admin/login', {
    method: 'POST', body: { username: app.config.adminUsername, password: app.config.adminPassword },
  })).status, 401);
  assert.equal((await app.send('/web/admin/login', {
    method: 'POST', body: { username: app.config.adminUsername, password: '516204' },
  })).status, 200);
});

test('普通管理员可软删除并释放用户名，所有者和当前账号不可删除', async (t) => {
  const app = await fixture(t);
  const owner = await app.owner();
  const created = await app.send('/web/admin/admins', {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf,
    body: { username: 'delete-me', display_name: '待删除账号', password: '618305', role: 'support' },
  });
  assert.equal(created.status, 201);
  const staff = await app.send('/web/admin/login', { method: 'POST', body: { username: 'delete-me', password: '618305' } });
  assert.equal(staff.status, 200);
  const selfDelete = await app.send(`/web/admin/admins/${created.data.id}`, {
    method: 'DELETE', cookie: staff.cookie.split(';')[0], csrf: staff.data.csrf_token,
  });
  assert.equal(selfDelete.status, 403);
  const ownerRow = app.repository.adminByUsername(app.config.adminUsername);
  assert.equal((await app.send(`/web/admin/admins/${ownerRow.id}`, {
    method: 'DELETE', cookie: owner.cookie, csrf: owner.csrf,
  })).status, 403);
  assert.equal((await app.send(`/web/admin/admins/${created.data.id}`, {
    method: 'DELETE', cookie: owner.cookie, csrf: owner.csrf,
  })).status, 200);
  assert.equal((await app.send('/web/admin/overview', { cookie: staff.cookie.split(';')[0] })).status, 401);
  assert.equal(app.repository.adminByUsername('delete-me'), undefined);
  assert.equal(app.repository.adminById(created.data.id).deleted_username, 'delete-me');
  const recreated = await app.send('/web/admin/admins', {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf,
    body: { username: 'delete-me', display_name: '重新创建', password: '729416', role: 'support' },
  });
  assert.equal(recreated.status, 201);
  assert.ok(app.repository.listAudit(20).some((event) => event.action === 'admin.deleted' && event.subject_id === created.data.id));
});

test('授权 Key 没有删除接口，撤销只改变状态并保留记录', async (t) => {
  const app = await fixture(t);
  const owner = await app.owner();
  const issued = await issue(app, owner, { customerRef: 'ORDER-KEEP-KEY' });
  const deleted = await app.send(`/web/admin/licenses/${issued.license_id}`, {
    method: 'DELETE', cookie: owner.cookie, csrf: owner.csrf,
  });
  assert.equal(deleted.status, 404);
  const revoked = await app.send(`/web/admin/licenses/${issued.license_id}/status`, {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf, body: { status: 'revoked' },
  });
  assert.equal(revoked.status, 200);
  const row = app.repository.licenseById(issued.license_id);
  assert.ok(row);
  assert.equal(row.status, 'revoked');
});

test('只有平台所有者重新验证密码后可查看加密保存的完整 Key，审计不记录明文', async (t) => {
  const app = await fixture(t);
  const owner = await app.owner();
  const issued = await issue(app, owner, { customerRef: 'ORDER-REVEAL-KEY' });

  const wrongPassword = await app.send(`/web/admin/licenses/${issued.license_id}/key`, {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf, body: { password: 'wrong-password' },
  });
  assert.equal(wrongPassword.status, 403);
  assert.equal(wrongPassword.data.error.code, 'ADMIN_PASSWORD_CURRENT_INVALID');

  const revealed = await app.send(`/web/admin/licenses/${issued.license_id}/key`, {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf, body: { password: app.config.adminPassword },
  });
  assert.equal(revealed.status, 200);
  assert.equal(revealed.data.license_key, issued.license_key);

  const created = await app.send('/web/admin/admins', {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf,
    body: { username: 'license.operator', display_name: '授权运营', password: '583214', role: 'license_ops' },
  });
  const operator = await app.send('/web/admin/login', { method: 'POST', body: { username: 'license.operator', password: '583214' } });
  const forbidden = await app.send(`/web/admin/licenses/${issued.license_id}/key`, {
    method: 'POST', cookie: operator.cookie.split(';')[0], csrf: operator.data.csrf_token, body: { password: '583214' },
  });
  assert.equal(created.status, 201);
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.data.error.code, 'LICENSE_KEY_REVEAL_FORBIDDEN');

  const event = app.repository.listAudit(20).find((item) => item.action === 'license.key_viewed');
  assert.ok(event);
  assert.equal(event.subject_id, issued.license_id);
  assert.ok(!JSON.stringify(event).includes(issued.license_key));

  app.database.prepare('UPDATE licenses SET key_encrypted = NULL WHERE id = ?').run(issued.license_id);
  const legacy = await app.send(`/web/admin/licenses/${issued.license_id}/key`, {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf, body: { password: app.config.adminPassword },
  });
  assert.equal(legacy.status, 409);
  assert.equal(legacy.data.error.code, 'LICENSE_KEY_LEGACY');
});

test('客户公告通过独立接口发布并写入审计', async (t) => {
  const app = await fixture(t);
  const owner = await app.owner();
  const updated = await app.send('/web/admin/announcement', {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf,
    body: { title: '系统维护通知', body: '今晚进行例行维护。', enabled: true },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.announcement_title, '系统维护通知');
  assert.equal(updated.data.announcement_body, '今晚进行例行维护。');
  assert.equal(updated.data.announcement_enabled, true);
  assert.match(updated.data.system_version, /^\d+\.\d+\.\d+$/);
  assert.ok(app.repository.listAudit(20).some((event) => event.action === 'announcement.updated'));
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
      domain_migration_cooldown_hours: 36,
      announcement_title: '维护公告',
      announcement_body: '今晚进行例行维护。',
      announcement_enabled: true,
    },
  });
  assert.equal(settings.status, 200);
  assert.equal(settings.data.platform_name, 'APPGOG 正式授权中心');
  assert.equal(settings.data.license_public_url, app.config.publicBaseUrl);
  assert.equal(settings.data.domain_migration_cooldown_hours, 36);
  assert.equal(settings.data.announcement_enabled, true);

  const deploymentSetting = await app.send('/web/admin/cms/settings', {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf,
    body: { build_public_url: 'https://forbidden.example.com', worker_enabled: false },
  });
  assert.equal(deploymentSetting.status, 403);
  assert.equal(deploymentSetting.data.error.code, 'DEPLOYMENT_SETTING_READ_ONLY');

  const invalidCooldown = await app.send('/web/admin/cms/settings', {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf,
    body: { domain_migration_cooldown_hours: -1 },
  });
  assert.equal(invalidCooldown.status, 400);
  assert.equal(invalidCooldown.data.error.code, 'DOMAIN_MIGRATION_COOLDOWN_INVALID');

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
    body: { username: 'cms-support', display_name: 'CMS 客服', password: '405918', role: 'support' },
  });
  assert.equal(staffCreated.status, 201);
  const staff = await app.send('/web/admin/login', { method: 'POST', body: { username: 'cms-support', password: '405918' } });
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
      assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'install_receipts'").get());
      assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'domain_migration_requests'").get());
      assert.ok(upgraded.prepare('PRAGMA table_info(licenses)').all().some((column) => column.name === 'max_activations'));
      const migration = upgraded.prepare("SELECT applied_at FROM schema_migrations WHERE version = '2026-09-23-v1.0.0-baseline'").get();
      assert.ok(migration?.applied_at);
      assert.ok(upgraded.prepare("SELECT applied_at FROM schema_migrations WHERE version = '2026-09-23-v1.0.0-domain-normalization'").get());
    } finally { upgraded.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('已经记录旧基线迁移的生产数据库仍会追加完整 Key 加密字段', () => {
  const root = mkdtempSync(join(tmpdir(), 'appgog-v120-migrate-test-'));
  const path = join(root, 'legacy-v113.sqlite');
  try {
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES ('2026-09-23-v1.0.0-baseline', '2026-09-23T00:00:00.000Z');
      CREATE TABLE licenses (
        id TEXT PRIMARY KEY, product_id TEXT NOT NULL, customer_ref TEXT NOT NULL,
        key_prefix TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
        bound_domain TEXT, update_until TEXT, max_builds_per_day INTEGER NOT NULL DEFAULT 3,
        max_activations INTEGER NOT NULL DEFAULT 1, generation INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    old.close();
    const upgraded = openDatabase(path);
    try {
      assert.ok(upgraded.prepare('PRAGMA table_info(licenses)').all().some((column) => column.name === 'key_encrypted'));
      assert.ok(upgraded.prepare("SELECT applied_at FROM schema_migrations WHERE version = '2026-09-23-v1.2.0-license-key-encryption'").get());
    } finally { upgraded.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('已经记录旧基线迁移但缺少后续列的生产数据库会安全补齐并保留管理员', () => {
  const root = mkdtempSync(join(tmpdir(), 'appgog-v125-migrate-test-'));
  const path = join(root, 'legacy-baseline.sqlite');
  try {
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES ('2026-09-23-v1.0.0-baseline', '2026-09-23T00:00:00.000Z');
      CREATE TABLE admin_users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO admin_users VALUES (
        'adm_legacy', 'legacy-owner', 'hashed-placeholder', 'active', '2025-01-01', '2025-01-01'
      );
      CREATE TABLE licenses (
        id TEXT PRIMARY KEY, product_id TEXT NOT NULL, customer_ref TEXT NOT NULL,
        key_prefix TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
        bound_domain TEXT, update_until TEXT, max_builds_per_day INTEGER NOT NULL DEFAULT 3,
        max_activations INTEGER NOT NULL DEFAULT 1, generation INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    old.close();

    const upgraded = openDatabase(path);
    try {
      const columns = new Set(upgraded.prepare('PRAGMA table_info(admin_users)').all().map((column) => column.name));
      assert.ok(columns.has('deleted_at'));
      assert.ok(columns.has('deleted_username'));

      const owner = upgraded.prepare(`
        SELECT username, role, is_owner, deleted_at, deleted_username
        FROM admin_users WHERE id = 'adm_legacy'
      `).get();
      assert.equal(owner.username, 'legacy-owner');
      assert.equal(owner.role, 'owner');
      assert.equal(owner.is_owner, 1);
      assert.equal(owner.deleted_at, null);
      assert.equal(owner.deleted_username, null);
      assert.ok(upgraded.prepare("SELECT applied_at FROM schema_migrations WHERE version = '2026-09-23-v1.0.0-baseline'").get());
      assert.ok(upgraded.prepare("SELECT applied_at FROM schema_migrations WHERE version = '2026-09-24-v1.2.5-additive-column-reconciliation'").get());
      assert.ok(createRepository(upgraded));
    } finally { upgraded.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

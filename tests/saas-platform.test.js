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
  async function sendRaw(path, {
    method = 'POST', buffer, contentType = 'application/octet-stream', cookie, csrf,
  } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(buffer !== undefined ? { 'content-type': contentType } : {}),
        ...(cookie ? { cookie } : {}),
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
      },
      ...(buffer !== undefined ? { body: buffer } : {}),
    });
    const raw = Buffer.from(await response.arrayBuffer());
    const responseType = response.headers.get('content-type') ?? '';
    let data = raw;
    if (responseType.includes('application/json')) {
      try { data = JSON.parse(raw.toString('utf8')); } catch { data = {}; }
    }
    return { status: response.status, headers: response.headers, data, buffer: raw };
  }
  async function login(path, body) {
    const response = await send(path, { method: 'POST', body });
    return { ...response, cookie: response.cookie?.split(';')[0], csrf: response.data?.csrf_token };
  }
  const owner = () => login('/web/admin/login', { username: config.adminUsername, password: config.adminPassword });
  const customer = (licenseKey) => login('/web/customer/login', { license_key: licenseKey });
  return { ...app, database, publicKey, base, config, send, sendRaw, owner, customer, setNow(value) { now = new Date(value); } };
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

async function issue(app, admin, {
  customerRef = 'ORDER-SAAS', domain = 'customer.example.com', updateUntil, planCode,
} = {}) {
  const result = await app.send('/web/admin/licenses', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: {
      customer_ref: customerRef, domain, update_until: updateUntil,
      ...(planCode ? { plan_code: planCode } : {}), max_builds_per_day: planCode === 'free' ? 1 : 10,
    },
  });
  assert.equal(result.status, 201);
  return result.data;
}

function addPublishedVersion(app, { version, publishedAt, releaseNotes = '', accessTier = 'free' }) {
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
      release_notes, channel, release_kind, access_tier, min_xboard_version, min_upgrade_version,
      rollback_allowed, rollback_to, published_at, created_at
    ) VALUES (?, ?, ?, ?, 'official', ?, 'active', ?, 'stable', 'feature', ?, '1.9.0', '1.4.0', 1, '1.4.2', ?, ?)
  `).run(`src_saas_${version}`, product.id, version, `APPGOG ${version}`, ref,
    releaseNotes, accessTier, publishedAt, publishedAt);
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

test('版本发布权益决定客户最新可用版本，并在构建接口再次强制校验', async (t) => {
  const app = await fixture(t, '2026-09-25T08:00:00.000Z');
  addPublishedVersion(app, {
    version: '2.0.0', publishedAt: '2026-09-24T08:00:00.000Z',
    releaseNotes: '免费维护版本', accessTier: 'free',
  });
  addPublishedVersion(app, {
    version: '2.1.0', publishedAt: '2026-09-25T07:00:00.000Z',
    releaseNotes: '付费功能版本', accessTier: 'paid',
  });
  const owner = await app.owner();
  const free = await issue(app, owner, {
    customerRef: 'ORDER-FREE-VERSION', domain: 'free-tier.example.com', planCode: 'free',
  });
  const freeCustomer = await app.customer(free.license_key);
  const freeOverview = await app.send('/web/customer/overview', { cookie: freeCustomer.cookie });
  assert.equal(freeOverview.status, 200);
  assert.equal(freeOverview.data.license.plan_code, 'free');
  assert.equal(freeOverview.data.latest_version, '2.1.0');
  assert.equal(freeOverview.data.latest_eligible_version, '2.0.0');
  const locked = freeOverview.data.versions.find((item) => item.version === '2.1.0');
  assert.equal(locked.access_tier, 'paid');
  assert.equal(locked.eligible, false);
  assert.equal(locked.eligibility_code, 'VERSION_PLAN_REQUIRED');
  assert.equal(freeOverview.data.versions.find((item) => item.version === '2.0.0').is_latest_eligible, true);
  const denied = await app.send('/web/customer/builds', {
    method: 'POST', cookie: freeCustomer.cookie, csrf: freeCustomer.csrf,
    body: { version: '2.1.0', domain: 'free-tier.example.com', intent: 'update' },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.error.code, 'VERSION_PLAN_REQUIRED');
  const allowedFree = await app.send('/web/customer/builds', {
    method: 'POST', cookie: freeCustomer.cookie, csrf: freeCustomer.csrf,
    body: { version: '2.0.0', domain: 'free-tier.example.com', intent: 'update' },
  });
  assert.equal(allowedFree.status, 201);

  const paid = await issue(app, owner, {
    customerRef: 'ORDER-PAID-VERSION', domain: 'paid-tier.example.com', planCode: 'paid',
  });
  const paidCustomer = await app.customer(paid.license_key);
  const paidOverview = await app.send('/web/customer/overview', { cookie: paidCustomer.cookie });
  assert.equal(paidOverview.data.latest_eligible_version, '2.1.0');
  assert.equal(paidOverview.data.versions.find((item) => item.version === '2.1.0').eligible, true);
  const allowedPaid = await app.send('/web/customer/builds', {
    method: 'POST', cookie: paidCustomer.cookie, csrf: paidCustomer.csrf,
    body: { version: '2.1.0', domain: 'paid-tier.example.com', intent: 'update' },
  });
  assert.equal(allowedPaid.status, 201);
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

test('工单内部附件只对管理员可见，客户附件固定公开且关闭后禁止上传', async (t) => {
  const app = await fixture(t);
  const owner = await app.owner();
  const issued = await issue(app, owner, { customerRef: 'ORDER-TICKET-ATTACHMENT', domain: 'attachment.example.com' });
  const customer = await app.customer(issued.license_key);
  const created = await app.send('/web/customer/tickets', {
    method: 'POST', cookie: customer.cookie, csrf: customer.csrf,
    body: { category: 'install', priority: 'normal', subject: '附件权限验证', body: '请核对内部附件隔离。' },
  });
  assert.equal(created.status, 201);

  const internalBody = Buffer.from('private-admin-log');
  const internal = await app.sendRaw(`/web/admin/tickets/${created.data.id}/attachments?visibility=internal&filename=private.log`, {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf, buffer: internalBody, contentType: 'text/plain',
  });
  assert.equal(internal.status, 201);

  const adminView = await app.send(`/web/admin/tickets/${created.data.id}`, { cookie: owner.cookie });
  const customerView = await app.send(`/web/customer/tickets/${created.data.id}`, { cookie: customer.cookie });
  assert.equal(adminView.data.attachments.some((item) => item.id === internal.data.id && item.visibility === 'internal'), true);
  assert.equal(customerView.data.attachments.some((item) => item.id === internal.data.id), false);

  const customerDenied = await app.sendRaw(`/web/customer/tickets/${created.data.id}/attachments/${internal.data.id}`, {
    method: 'GET', cookie: customer.cookie,
  });
  assert.equal(customerDenied.status, 404);
  const adminDownload = await app.sendRaw(`/web/admin/tickets/${created.data.id}/attachments/${internal.data.id}`, {
    method: 'GET', cookie: owner.cookie,
  });
  assert.equal(adminDownload.status, 200);
  assert.deepEqual(adminDownload.buffer, internalBody);

  const customerUpload = await app.sendRaw(`/web/customer/tickets/${created.data.id}/attachments?visibility=internal&filename=customer.log`, {
    method: 'POST', cookie: customer.cookie, csrf: customer.csrf, buffer: Buffer.from('customer-log'), contentType: 'text/plain',
  });
  assert.equal(customerUpload.status, 201);
  const adminAfterCustomerUpload = await app.send(`/web/admin/tickets/${created.data.id}`, { cookie: owner.cookie });
  assert.equal(adminAfterCustomerUpload.data.attachments.find((item) => item.id === customerUpload.data.id)?.visibility, 'public');

  const closed = await app.send(`/web/customer/tickets/${created.data.id}/close`, {
    method: 'POST', cookie: customer.cookie, csrf: customer.csrf, body: { reason: '附件权限已验证' },
  });
  assert.equal(closed.status, 200);
  const uploadAfterClose = await app.sendRaw(`/web/admin/tickets/${created.data.id}/attachments?visibility=public&filename=late.log`, {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf, buffer: Buffer.from('late'), contentType: 'text/plain',
  });
  assert.equal(uploadAfterClose.status, 409);
});

test('customer and admin can close tickets, only admin can reopen, and lifecycle is audited', async (t) => {
  const app = await fixture(t);
  const owner = await app.owner();
  const issued = await issue(app, owner, { customerRef: 'ORDER-TICKET-LIFECYCLE', domain: 'ticket-life.example.com' });
  const customer = await app.customer(issued.license_key);
  const created = await app.send('/web/customer/tickets', {
    method: 'POST', cookie: customer.cookie, csrf: customer.csrf,
    body: { category: 'install', priority: 'normal', subject: '安装问题', body: '安装后需要确认工单关闭流程。' },
  });
  assert.equal(created.status, 201);

  const closedByCustomer = await app.send(`/web/customer/tickets/${created.data.id}/close`, {
    method: 'POST', cookie: customer.cookie, csrf: customer.csrf, body: { reason: '客户确认问题已经解决' },
  });
  assert.equal(closedByCustomer.status, 200);
  assert.equal(closedByCustomer.data.status, 'closed');
  assert.equal(closedByCustomer.data.closed_by_type, 'customer');
  assert.equal(closedByCustomer.data.close_reason, '客户确认问题已经解决');
  assert.equal((await app.send(`/web/customer/tickets/${created.data.id}/messages`, {
    method: 'POST', cookie: customer.cookie, csrf: customer.csrf, body: { body: '关闭后不能继续回复' },
  })).status, 409);

  const reopened = await app.send(`/web/admin/tickets/${created.data.id}/update`, {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf,
    body: { status: 'pending', close_reason: '需要补充验证信息' },
  });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.data.status, 'pending');
  assert.ok(reopened.data.reopened_at);
  assert.equal(reopened.data.close_reason, null);

  const closedByAdmin = await app.send(`/web/admin/tickets/${created.data.id}/update`, {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf,
    body: { status: 'closed', close_reason: '管理员完成最终验证' },
  });
  assert.equal(closedByAdmin.status, 200);
  assert.equal(closedByAdmin.data.closed_by_type, 'admin');
  assert.equal(closedByAdmin.data.close_reason, '管理员完成最终验证');

  const events = app.repository.listAudit(50).filter((event) => event.subject_id === created.data.id).map((event) => event.action);
  assert.ok(events.includes('support_ticket.closed'));
  assert.ok(events.includes('support_ticket.reopened'));
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

test('只有平台所有者二次验证并输入确认文本后可永久删除 Key、关联记录和文件', async (t) => {
  const app = await fixture(t);
  const owner = await app.owner();
  const issued = await issue(app, owner, { customerRef: 'ORDER-DELETE-KEY', domain: 'delete.example.com' });
  const customer = await app.customer(issued.license_key);
  const now = '2026-09-22T08:00:00.000Z';
  const uploadRef = `license-uploads/${issued.license_id}/source.zip`;
  const attachmentRef = `support/${issued.license_id}/proof.txt`;
  app.artifactStore.put(uploadRef, Buffer.from('source'));
  app.artifactStore.put(attachmentRef, Buffer.from('proof'));
  const job = app.repository.createBuildJob({
    id: 'job_delete_contract', licenseId: issued.license_id, version: '1.0.0',
    domain: 'delete.example.com', sourceKind: 'upload', uploadRef, now,
  });
  const ticket = app.repository.createSupportTicket({
    id: 'tkt_delete_contract', ticketNumber: 'TK-DELETE-CONTRACT', licenseId: issued.license_id,
    buildJobId: job.id, category: 'packaging', subject: '删除测试', now,
  });
  const message = app.repository.addSupportMessage({ ticketId: ticket.id, actorType: 'customer', actorId: issued.license_id, body: '测试附件', now });
  app.repository.createSupportAttachment({
    ticketId: ticket.id, messageId: message.id, originalName: 'proof.txt', storageRef: attachmentRef,
    contentType: 'text/plain', sizeBytes: 5, sha256: '0'.repeat(64), now,
  });
  app.database.prepare(`
    INSERT INTO build_tickets (
      id, license_id, token_hash, requested_version, requested_domain, status, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, 'consumed', ?, ?)
  `).run('btk_delete_contract', issued.license_id, 'hash_delete_ticket', '1.0.0', 'delete.example.com', now, now);
  app.database.prepare(`
    INSERT INTO builds (
      id, license_id, ticket_id, version, domain, package_id, package_secret_hash, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'activated', ?)
  `).run('bld_delete_contract', issued.license_id, 'btk_delete_contract', '1.0.0', 'delete.example.com', 'pkg_delete_contract', 'hash_delete_package', now);
  app.database.prepare(`
    INSERT INTO install_activation_windows (
      id, build_id, installation_id, domain, token_hash, status, started_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, 'expired', ?, ?)
  `).run('iaw_delete_contract', 'bld_delete_contract', 'ins_delete_contract', 'delete.example.com', 'hash_delete_window', now, now);
  app.database.prepare(`
    INSERT INTO activations (
      id, license_id, build_id, domain, backend_origin, installation_id, status, generation,
      refresh_secret_hash, last_seen_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)
  `).run('act_delete_contract', issued.license_id, 'bld_delete_contract', 'delete.example.com',
    'https://panel.delete.example.com', 'ins_delete_contract', 'hash_delete_refresh', now, now);
  app.database.prepare(`
    INSERT INTO offline_license_files (id, activation_id, token_hash, format_version, issued_at, expires_at)
    VALUES (?, ?, ?, 'offline-license-v1', ?, ?)
  `).run('olf_delete_contract', 'act_delete_contract', 'hash_delete_offline', now, now);

  const wrongPassword = await app.send(`/web/admin/licenses/${issued.license_id}`, {
    method: 'DELETE', cookie: owner.cookie, csrf: owner.csrf,
    body: { password: 'wrong', confirmation: `DELETE ${issued.license_id}` },
  });
  assert.equal(wrongPassword.status, 403);
  const wrongConfirmation = await app.send(`/web/admin/licenses/${issued.license_id}`, {
    method: 'DELETE', cookie: owner.cookie, csrf: owner.csrf,
    body: { password: app.config.adminPassword, confirmation: 'DELETE' },
  });
  assert.equal(wrongConfirmation.status, 400);

  const deleted = await app.send(`/web/admin/licenses/${issued.license_id}`, {
    method: 'DELETE', cookie: owner.cookie, csrf: owner.csrf,
    body: { password: app.config.adminPassword, confirmation: `DELETE ${issued.license_id}` },
  });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.deleted, true);
  assert.equal(deleted.data.cleanup_pending, 0);
  assert.equal(app.repository.licenseById(issued.license_id), undefined);
  for (const table of ['install_activation_windows', 'offline_license_files', 'activations', 'builds', 'build_tickets']) {
    assert.equal(app.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, `${table} 应清空`);
  }
  for (const table of ['build_jobs', 'support_tickets', 'support_messages', 'support_attachments', 'license_events']) {
    const row = app.database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${table === 'support_messages' || table === 'support_attachments' ? "ticket_id = 'tkt_delete_contract'" : 'license_id = ?'}`);
    const result = table === 'support_messages' || table === 'support_attachments' ? row.get() : row.get(issued.license_id);
    assert.equal(result.count, 0, `${table} 应清空`);
  }
  assert.equal((await app.send('/web/customer/overview', { cookie: customer.cookie })).status, 401);
  assert.throws(() => app.artifactStore.read(uploadRef));
  assert.throws(() => app.artifactStore.read(attachmentRef));
  assert.equal(app.database.prepare('SELECT COUNT(*) AS count FROM erasure_jobs').get().count, 0);
  const tombstone = app.database.prepare('SELECT * FROM erasure_tombstones').get();
  assert.equal(tombstone.result, 'completed');
  const serialized = JSON.stringify(tombstone);
  assert.ok(!serialized.includes(issued.license_id));
  assert.ok(!serialized.includes('ORDER-DELETE-KEY'));
  assert.ok(!serialized.includes('delete.example.com'));
});

test('永久删除失败文件进入补偿队列并可幂等重试完成', async (t) => {
  const app = await fixture(t);
  const owner = await app.owner();
  const issued = await issue(app, owner, { customerRef: 'ORDER-CLEANUP-RETRY', domain: 'cleanup.example.com' });
  const now = '2026-09-22T08:00:00.000Z';
  const uploadRef = `license-uploads/${issued.license_id}/cleanup.zip`;
  app.artifactStore.put(uploadRef, Buffer.from('cleanup-source'));
  app.repository.createBuildJob({
    id: 'job_cleanup_retry', licenseId: issued.license_id, version: '1.0.0',
    domain: 'cleanup.example.com', sourceKind: 'upload', uploadRef, now,
  });

  const originalRemove = app.artifactStore.remove.bind(app.artifactStore);
  let failOnce = true;
  app.artifactStore.remove = (storageRef) => {
    if (storageRef === uploadRef && failOnce) {
      failOnce = false;
      throw new Error('simulated cleanup failure');
    }
    return originalRemove(storageRef);
  };

  const deleted = await app.send(`/web/admin/licenses/${issued.license_id}`, {
    method: 'DELETE', cookie: owner.cookie, csrf: owner.csrf,
    body: { password: app.config.adminPassword, confirmation: `DELETE ${issued.license_id}` },
  });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.cleanup_pending, 1);
  assert.equal(app.repository.licenseById(issued.license_id), undefined);
  const pending = app.database.prepare('SELECT * FROM file_cleanup_tasks').get();
  assert.equal(pending.status, 'pending');
  assert.equal(pending.storage_ref, uploadRef);
  assert.equal(app.database.prepare('SELECT result FROM erasure_tombstones').get().result, 'completed_with_cleanup_pending');

  app.artifactStore.remove = originalRemove;
  const retried = await app.send('/web/admin/erasure-cleanup/retry', {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf,
  });
  assert.equal(retried.status, 200);
  assert.equal(retried.data.completed, 1);
  assert.equal(retried.data.failed, 0);
  assert.throws(() => app.artifactStore.read(uploadRef));
  const completed = app.database.prepare('SELECT * FROM file_cleanup_tasks').get();
  assert.equal(completed.status, 'completed');
  assert.ok(completed.completed_at);
  assert.equal(app.database.prepare('SELECT result FROM erasure_tombstones').get().result, 'completed');

  const repeated = await app.send('/web/admin/erasure-cleanup/retry', {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf,
  });
  assert.equal(repeated.status, 200);
  assert.deepEqual(repeated.data, { processed: 0, completed: 0, failed: 0, pending: 0 });
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

test('只读管理员可查看统一授权事件且安全字段不会泄露', async (t) => {
  const app = await fixture(t);
  const owner = await app.owner();
  const issued = await issue(app, owner, { customerRef: 'ORDER-EVENTS', domain: 'events.example.com' });
  const now = '2026-09-22T08:00:00.000Z';
  app.repository.recordLicenseEvent({
    licenseId: issued.license_id, eventType: 'license.security_probe', actorType: 'system',
    metadata: {
      safe_field: 'visible', api_token: 'hidden-token',
      nested: { license_key: issued.license_key, note: 'visible-note' },
    },
    now,
  });

  const created = await app.send('/web/admin/admins', {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf,
    body: { username: 'event.auditor', display_name: '事件审计', password: '416825', role: 'auditor' },
  });
  assert.equal(created.status, 201);
  const auditor = await app.send('/web/admin/login', {
    method: 'POST', body: { username: 'event.auditor', password: '416825' },
  });
  assert.equal(auditor.status, 200);
  const auditorCookie = auditor.cookie.split(';')[0];

  const events = await app.send(`/web/admin/licenses/${issued.license_id}/events`, { cookie: auditorCookie });
  assert.equal(events.status, 200);
  assert.ok(events.data.events.some((event) => event.event_type === 'license.issued'));
  const probe = events.data.events.find((event) => event.event_type === 'license.security_probe');
  assert.equal(probe.metadata.safe_field, 'visible');
  assert.equal(probe.metadata.api_token, '[REDACTED]');
  assert.equal(probe.metadata.nested.license_key, '[REDACTED]');
  assert.equal(probe.metadata.nested.note, 'visible-note');
  assert.equal(Object.hasOwn(probe, 'metadata_json'), false);
  const serialized = JSON.stringify(events.data);
  assert.equal(serialized.includes(issued.license_key), false);
  assert.equal(serialized.includes('hidden-token'), false);

  const forbiddenWrite = await app.send(`/web/admin/licenses/${issued.license_id}/domain`, {
    method: 'POST', cookie: auditorCookie, csrf: auditor.data.csrf_token,
    body: { domain: 'forbidden.example.com' },
  });
  assert.equal(forbiddenWrite.status, 403);
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
      assert.ok(upgraded.prepare('PRAGMA table_info(source_versions)').all().some((column) => column.name === 'access_tier'));
      assert.ok(upgraded.prepare('PRAGMA table_info(build_jobs)').all().some((column) => column.name === 'intent'));
      assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'install_receipts'").get());
      assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'domain_migration_requests'").get());
      assert.ok(upgraded.prepare('PRAGMA table_info(licenses)').all().some((column) => column.name === 'max_activations'));
      const migration = upgraded.prepare("SELECT applied_at FROM schema_migrations WHERE version = '2026-09-23-v1.0.0-baseline'").get();
      assert.ok(migration?.applied_at);
      assert.ok(upgraded.prepare("SELECT applied_at FROM schema_migrations WHERE version = '2026-09-23-v1.0.0-domain-normalization'").get());
    } finally { upgraded.close(); }
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test('旧工单附件与补偿清理表会追加 Phase 4 字段并保留记录', () => {
  const root = mkdtempSync(join(tmpdir(), 'appgog-v1214-migrate-test-'));
  const path = join(root, 'legacy-phase-four.sqlite');
  try {
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE support_attachments (
        id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, message_id TEXT,
        original_name TEXT NOT NULL, storage_ref TEXT NOT NULL UNIQUE,
        content_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO support_attachments VALUES (
        'att_legacy', 'tkt_legacy', NULL, 'legacy.log', 'support/legacy.log',
        'text/plain', 6, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '2026-09-20T00:00:00.000Z'
      );
      CREATE TABLE file_cleanup_tasks (
        id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, storage_ref TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(operation_id, storage_ref)
      );
      INSERT INTO file_cleanup_tasks VALUES (
        'fct_legacy', 'ers_legacy', 'support/legacy.log', 'pending', 1, '旧错误',
        '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z'
      );
    `);
    old.close();

    const upgraded = openDatabase(path);
    try {
      const attachmentColumns = new Set(upgraded.prepare('PRAGMA table_info(support_attachments)').all().map((column) => column.name));
      assert.ok(attachmentColumns.has('visibility'));
      assert.ok(attachmentColumns.has('actor_type'));
      assert.ok(attachmentColumns.has('actor_id'));
      const attachment = upgraded.prepare("SELECT * FROM support_attachments WHERE id = 'att_legacy'").get();
      assert.equal(attachment.visibility, 'public');
      assert.equal(attachment.actor_type, 'system');
      assert.equal(attachment.original_name, 'legacy.log');

      const cleanupColumns = new Set(upgraded.prepare('PRAGMA table_info(file_cleanup_tasks)').all().map((column) => column.name));
      assert.ok(cleanupColumns.has('completed_at'));
      const cleanup = upgraded.prepare("SELECT * FROM file_cleanup_tasks WHERE id = 'fct_legacy'").get();
      assert.equal(cleanup.status, 'pending');
      assert.equal(cleanup.completed_at, null);
      assert.ok(upgraded.prepare("SELECT applied_at FROM schema_migrations WHERE version = '2026-09-25-v1.2.14-events-erasure-support'").get());
    } finally { upgraded.close(); }
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test('旧激活数据库升级会追加安装窗口、离线文件与恢复代次并保留激活记录', () => {
  const root = mkdtempSync(join(tmpdir(), 'appgog-v122-lifecycle-migrate-test-'));
  const path = join(root, 'legacy-lifecycle.sqlite');
  let upgraded = null;
  try {
    const initialized = openDatabase(path);
    initialized.close();
    const old = new DatabaseSync(path);
    old.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE offline_license_files;
      DROP TABLE install_activation_windows;
      DROP TABLE activations;
      CREATE TABLE activations (
        id TEXT PRIMARY KEY,
        license_id TEXT NOT NULL,
        build_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        backend_origin TEXT NOT NULL,
        installation_id TEXT NOT NULL,
        status TEXT NOT NULL,
        generation INTEGER NOT NULL,
        refresh_secret_hash TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        identity_mode TEXT NOT NULL DEFAULT 'legacy',
        installation_public_key_fingerprint TEXT,
        UNIQUE(build_id, domain, installation_id)
      );
      INSERT INTO activations VALUES (
        'act_legacy_lifecycle', 'lic_legacy', 'bld_legacy', 'legacy.example.com',
        'https://panel.example.com', 'ins_legacy_lifecycle_001', 'active', 1,
        'legacy-refresh-hash', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z',
        NULL, 'server_key', 'legacy-fingerprint'
      );
      DELETE FROM schema_migrations WHERE version = '2026-09-25-v1.2.22-product-lifecycle';
    `);
    old.close();

    upgraded = openDatabase(path);
    try {
      const columns = new Set(upgraded.prepare('PRAGMA table_info(activations)').all().map((column) => column.name));
      assert.ok(columns.has('recovered_at'));
      assert.ok(columns.has('recovery_generation'));
      const activation = upgraded.prepare("SELECT * FROM activations WHERE id = 'act_legacy_lifecycle'").get();
      assert.equal(activation.status, 'active');
      assert.equal(activation.refresh_secret_hash, 'legacy-refresh-hash');
      assert.equal(activation.recovery_generation, 0);
      assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'install_activation_windows'").get());
      assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'offline_license_files'").get());
      assert.ok(upgraded.prepare("SELECT applied_at FROM schema_migrations WHERE version = '2026-09-25-v1.2.22-product-lifecycle'").get());
    } finally { upgraded.close(); upgraded = null; }
  } finally {
    upgraded?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
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
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
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

test('旧授权数据库升级会生成不可漂移的能力与额度快照并保留原额度', () => {
  const root = mkdtempSync(join(tmpdir(), 'appgog-v1215-entitlement-test-'));
  const path = join(root, 'legacy-entitlement.sqlite');
  try {
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES ('2026-09-23-v1.0.0-baseline', '2026-09-23T00:00:00.000Z');
      CREATE TABLE products (
        id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL
      );
      INSERT INTO products VALUES ('prd_legacy', 'appgog', 'APPGOG', 'active', '2025-01-01');
      CREATE TABLE licenses (
        id TEXT PRIMARY KEY, product_id TEXT NOT NULL, customer_ref TEXT NOT NULL,
        key_prefix TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
        bound_domain TEXT, update_until TEXT, max_builds_per_day INTEGER NOT NULL DEFAULT 3,
        max_activations INTEGER NOT NULL DEFAULT 1, generation INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO licenses VALUES (
        'lic_legacy', 'prd_legacy', 'legacy-customer', 'APPGOG-LEGACY', 'legacy-hash', 'active',
        'legacy.example.com', NULL, 7, 4, 1, '2025-01-01', '2025-01-01'
      );
    `);
    old.close();

    const upgraded = openDatabase(path);
    try {
      const license = upgraded.prepare(`
        SELECT max_builds_per_day, max_activations, plan_id,
          entitlement_capabilities_json, entitlement_limits_json
        FROM licenses WHERE id = 'lic_legacy'
      `).get();
      assert.equal(license.plan_id, 'plan_legacy');
      assert.equal(license.max_builds_per_day, 7);
      assert.equal(license.max_activations, 4);
      assert.ok(JSON.parse(license.entitlement_capabilities_json).includes('settings:write'));
      assert.deepEqual(JSON.parse(license.entitlement_limits_json), {
        max_builds_per_day: 7, max_activations: 4,
      });
      assert.ok(upgraded.prepare(
        "SELECT applied_at FROM schema_migrations WHERE version = '2026-09-25-v1.2.15-entitlement-snapshots'",
      ).get());
    } finally { upgraded.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('旧产品迁机记录升级会追加候选与回滚状态字段并保留原记录', () => {
  const root = mkdtempSync(join(tmpdir(), 'appgog-v1216-product-migration-test-'));
  const path = join(root, 'legacy-product-migration.sqlite');
  try {
    const old = openDatabase(path);
    old.exec(`
      DELETE FROM schema_migrations WHERE version = '2026-09-25-v1.2.16-product-migration-state';
      ALTER TABLE product_migration_grants RENAME TO product_migration_grants_current;
      CREATE TABLE product_migration_grants (
        id TEXT PRIMARY KEY,
        license_id TEXT NOT NULL,
        source_installation_id TEXT NOT NULL,
        target_public_key_fingerprint TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'issued',
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        rollback_until TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO product_migration_grants VALUES (
        'pmg_legacy', 'lic_legacy', 'ins_source', 'fingerprint', 'token-hash',
        'issued', '2026-10-01T00:00:00.000Z', NULL, '2026-10-01T00:30:00.000Z', '2026-09-25T00:00:00.000Z'
      );
      DROP TABLE product_migration_grants_current;
    `);
    old.close();

    const upgraded = openDatabase(path);
    try {
      const grant = upgraded.prepare("SELECT * FROM product_migration_grants WHERE id = 'pmg_legacy'").get();
      assert.equal(grant.source_installation_id, 'ins_source');
      assert.equal(grant.status, 'issued');
      assert.equal(grant.source_activation_id, null);
      assert.equal(grant.target_activation_id, null);
      assert.equal(grant.prepared_at, null);
      assert.equal(grant.committed_at, null);
      assert.equal(grant.rolled_back_at, null);
      assert.equal(grant.rollback_reason, null);
      assert.ok(upgraded.prepare(
        "SELECT applied_at FROM schema_migrations WHERE version = '2026-09-25-v1.2.16-product-migration-state'",
      ).get());
    } finally { upgraded.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

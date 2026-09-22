import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { bootstrap } from '../apps/license-api/src/bootstrap.js';
import { openDatabase } from '../apps/license-api/src/database.js';
import { createHttpHandler } from '../apps/license-api/src/http.js';
import { writeZip } from '../packages/core/src/zip.js';

function setup() {
  const database = openDatabase(':memory:');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const tempRoot = mkdtempSync(join(tmpdir(), 'appgog-web-test-'));
  let now = new Date('2026-09-22T04:00:00.000Z');
  const config = {
    pepper: 'test-pepper-that-is-definitely-longer-than-32-chars',
    sessionSecret: 'test-session-secret-that-is-more-than-32-characters',
    deliveryEncryptionKey: 'test-encryption-key-that-is-more-than-32-characters',
    adminToken: 'admin-test-token-1234567890',
    adminUsername: 'admin',
    adminPassword: 'admin-test-password-123',
    workerToken: 'worker-test-token-1234567890',
    publicBaseUrl: 'http://127.0.0.1:8787',
    activationTokenTtlSeconds: 604800,
    buildTicketTtlSeconds: 900,
    webSessionTtlSeconds: 28800,
    artifactRoot: join(tempRoot, 'artifacts'),
    uploadRoot: join(tempRoot, 'uploads'),
    maxSourceUploadBytes: 128 * 1024 * 1024,
  };
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const core = bootstrap({ database, config, privateKey, publicKey: publicKeyPem, clock: () => new Date(now) });
  return {
    database, config, publicKey, tempRoot,
    ...core,
    advance(milliseconds) { now = new Date(now.getTime() + milliseconds); },
    close() {
      database.close();
      rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

test('同站双入口：管理员与客户会话隔离，写操作必须有 CSRF', async (t) => {
  const app = setup();
  const server = createServer(createHttpHandler({
    service: app.service, sessions: app.sessions, portal: app.portal,
    config: app.config, publicKey: app.publicKey.export({ type: 'spki', format: 'pem' }),
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (path, { method = 'GET', body, cookie, csrf } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, cookie: response.headers.get('set-cookie'), data: await response.json() };
  };

  const page = await fetch(`${base}/build`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /客户交付中心/);

  const adminLogin = await send('/web/admin/login', {
    method: 'POST', body: { username: app.config.adminUsername, password: app.config.adminPassword },
  });
  assert.equal(adminLogin.status, 200);
  const adminCookie = adminLogin.cookie.split(';')[0];
  const adminCsrf = adminLogin.data.csrf_token;
  const blocked = await send('/web/admin/licenses', {
    method: 'POST', cookie: adminCookie,
    body: { customer_ref: 'ORDER-1', domain: 'demo.example.com' },
  });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.error.code, 'CSRF_INVALID');

  const issued = await send('/web/admin/licenses', {
    method: 'POST', cookie: adminCookie, csrf: adminCsrf,
    body: { customer_ref: 'ORDER-1', domain: 'demo.example.com', max_builds_per_day: 3 },
  });
  assert.equal(issued.status, 201);
  assert.match(issued.data.license_key, /^APPGOG-/);

  const draftVersion = await send('/web/admin/versions', {
    method: 'POST', cookie: adminCookie, csrf: adminCsrf,
    body: { version: '1.17.0', display_name: 'APPGOG 1.17.0' },
  });
  assert.equal(draftVersion.status, 201);
  assert.equal(draftVersion.data.status, 'draft');

  const customerLogin = await send('/web/customer/login', {
    method: 'POST', body: { license_key: issued.data.license_key },
  });
  assert.equal(customerLogin.status, 200);
  const customerCookie = customerLogin.cookie.split(';')[0];
  const customerCsrf = customerLogin.data.csrf_token;

  assert.equal((await send('/web/admin/overview', { cookie: customerCookie })).status, 401);
  assert.equal((await send('/web/customer/overview', { cookie: adminCookie })).status, 401);

  const customerOverview = await send('/web/customer/overview', { cookie: customerCookie });
  assert.equal(customerOverview.status, 200);
  assert.equal(customerOverview.data.license.bound_domain, 'demo.example.com');
  assert.equal(customerOverview.data.versions.length, 0);
  const prematureBuild = await send('/web/customer/builds', {
    method: 'POST', cookie: customerCookie, csrf: customerCsrf,
    body: { version: '1.17.0', domain: 'demo.example.com' },
  });
  assert.equal(prematureBuild.status, 409);
  assert.equal(prematureBuild.data.error.code, 'SOURCE_VERSION_NOT_READY');

  const changedDomain = await send(`/web/admin/licenses/${issued.data.license_id}/domain`, {
    method: 'POST', cookie: adminCookie, csrf: adminCsrf, body: { domain: 'new.example.com' },
  });
  assert.equal(changedDomain.status, 200);
  assert.equal(changedDomain.data.bound_domain, 'new.example.com');
  const suspended = await send(`/web/admin/licenses/${issued.data.license_id}/status`, {
    method: 'POST', cookie: adminCookie, csrf: adminCsrf, body: { status: 'suspended' },
  });
  assert.equal(suspended.status, 200);
  assert.equal(suspended.data.status, 'suspended');
  const oldCustomerSession = await send('/web/customer/overview', { cookie: customerCookie });
  assert.equal(oldCustomerSession.status, 403);
  const restored = await send(`/web/admin/licenses/${issued.data.license_id}/status`, {
    method: 'POST', cookie: adminCookie, csrf: adminCsrf, body: { status: 'active' },
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.data.status, 'active');
});

test('队列适配器与业务协议隔离：只可领取一次，返回 Build 与安装 Key', () => {
  const app = setup();
  const issued = app.service.issueLicense({ customerRef: 'ORDER-2', domain: 'demo.example.com' });
  const product = app.repository.productByCode('appgog');
  const sourceZip = writeZip(new Map([
    ['APPGOG/config.json', Buffer.from('{"name":"APPGOG"}')],
    ['APPGOG/index.html', Buffer.from('<!doctype html><html><head></head><body>APPGOG</body></html>')],
  ]));
  app.artifactStore.put('sources/test.zip', sourceZip);
  app.repository.createSourceVersion({
    productId: product.id,
    version: '1.17.0', displayName: 'APPGOG 1.17.0', sourceKind: 'official',
    sourceRef: 'sources/test.zip', status: 'active', now: '2026-09-22T04:00:00.000Z',
  });
  const login = app.sessions.loginCustomer(issued.licenseKey);
  const job = app.portal.enqueueCustomerBuild(login.session, { version: '1.17.0', domain: 'demo.example.com' });
  assert.equal(job.status, 'queued');
  const leased = app.portal.leaseBuild('worker-test');
  assert.equal(leased.job.id, job.id);
  assert.ok(leased.build.installKey.startsWith('INS-'));
  assert.equal(app.portal.leaseBuild('worker-test'), null);
  const outputZip = writeZip(new Map([
    ['APPGOG/config.json', Buffer.from('{"name":"APPGOG"}')],
    ['APPGOG/index.html', Buffer.from('<!doctype html><html><head></head><body>Protected</body></html>')],
  ]));
  const outputHash = createHash('sha256').update(outputZip).digest('hex');
  app.artifactStore.put('jobs/fake-test.zip', outputZip);
  const completed = app.portal.completeBuild('worker-test', job.id, {
    build_id: leased.build.buildId,
    artifact_ref: 'jobs/fake-test.zip',
    artifact_sha256: outputHash,
    install_key: leased.build.installKey,
  });
  assert.equal(completed.status, 'succeeded');
  const detail = app.portal.buildDetails(login.session, job.id);
  assert.equal(detail.install_key, leased.build.installKey);
  assert.equal(detail.artifact_sha256, outputHash);
  app.close();
});

test('构建失败撤销本次包与安装 Key，不永久占用打包额度', () => {
  const app = setup();
  const issued = app.service.issueLicense({ customerRef: 'ORDER-3', domain: 'demo.example.com', maxBuildsPerDay: 1 });
  const product = app.repository.productByCode('appgog');
  const sourceZip = writeZip(new Map([
    ['APPGOG/config.json', Buffer.from('{"name":"APPGOG"}')],
    ['APPGOG/index.html', Buffer.from('<!doctype html><html><head></head><body>APPGOG</body></html>')],
  ]));
  app.artifactStore.put('sources/failure-test.zip', sourceZip);
  app.repository.createSourceVersion({
    productId: product.id, version: '1.17.0', displayName: 'APPGOG 1.17.0',
    sourceKind: 'official', sourceRef: 'sources/failure-test.zip', status: 'active',
    now: '2026-09-22T04:00:00.000Z',
  });
  const session = app.sessions.loginCustomer(issued.licenseKey).session;
  const firstJob = app.portal.enqueueCustomerBuild(session, { version: '1.17.0', domain: 'demo.example.com' });
  const claimed = app.portal.leaseBuild('worker-test');
  const failed = app.portal.failBuild('worker-test', firstJob.id, { code: 'COMPILER_FAILED', message: '编译失败' });
  assert.equal(failed.status, 'failed');
  assert.equal(app.repository.buildById(claimed.build.buildId).status, 'revoked');
  assert.equal(app.repository.installKeyByBuildId(claimed.build.buildId).status, 'revoked');
  const secondJob = app.portal.enqueueCustomerBuild(session, { version: '1.17.0', domain: 'demo.example.com' });
  assert.equal(secondJob.status, 'queued');
  assert.ok(app.portal.leaseBuild('worker-test'));
  app.close();
});

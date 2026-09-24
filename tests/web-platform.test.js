import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    downloadTicketTtlSeconds: 300,
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
  const send = async (path, { method = 'GET', body, cookie, csrf, requestId } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
        ...(requestId ? { 'x-request-id': requestId } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: response.status,
      cookie: response.headers.get('set-cookie'),
      requestId: response.headers.get('x-request-id'),
      data: await response.json(),
    };
  };

  const correlated = await send('/web/session?actor=invalid', { requestId: 'request-contract-0001' });
  assert.equal(correlated.status, 400);
  assert.equal(correlated.requestId, 'request-contract-0001');
  assert.equal(correlated.data.error.request_id, 'request-contract-0001');
  assert.equal(correlated.data.error.code, 'ACTOR_INVALID');

  const page = await fetch(`${base}/build`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /data-portal="customer"/);

  const health = await fetch(`${base}/health`).then(response => response.json());
  const packageVersion = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version;
  assert.equal(health.version, packageVersion);
  assert.notEqual(health.version, '1.0.0');

  const portalAsset = await fetch(`${base}/assets/portal.js`);
  assert.equal(portalAsset.status, 200);
  assert.equal(portalAsset.headers.get('cache-control'), 'no-store');
  const portalApiClient = await fetch(`${base}/assets/portal/api-client.js`);
  assert.equal(portalApiClient.status, 200);
  assert.equal(portalApiClient.headers.get('content-type'), 'text/javascript; charset=utf-8');

  const adminPage = await fetch(`${base}/admin`);
  const adminHtml = await adminPage.text();
  assert.match(adminHtml, /id="logout" class="header-logout"/);
  assert.doesNotMatch(adminHtml, /id="account-menu"/);
  assert.doesNotMatch(adminHtml, /返回首页/);

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

test('Caddy 私网反代后的限流按合法 X-Forwarded-For 区分客户', async (t) => {
  const app = setup();
  const server = createServer(createHttpHandler({
    service: app.service, sessions: app.sessions, portal: app.portal, artifactStore: app.artifactStore,
    config: app.config, publicKey: app.publicKey.export({ type: 'spki', format: 'pem' }),
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (let index = 0; index < 13; index += 1) {
    const response = await fetch(`${base}/web/customer/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${index + 1}` },
      body: JSON.stringify({ license_key: 'APPGOG-INVALID-KEY' }),
    });
    assert.equal(response.status, 401);
  }
  for (let index = 0; index < 12; index += 1) {
    const response = await fetch(`${base}/web/customer/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.10' },
      body: JSON.stringify({ license_key: 'APPGOG-INVALID-KEY' }),
    });
    assert.equal(response.status, 401);
  }
  const limited = await fetch(`${base}/web/customer/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.10' },
    body: JSON.stringify({ license_key: 'APPGOG-INVALID-KEY' }),
  });
  assert.equal(limited.status, 429);
});

test('队列适配器与业务协议隔离：只可领取一次，返回 Build 与安装 Key', async () => {
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
  const output = await app.buildEngine.build({
    sourceRef: leased.source.source_ref,
    product: leased.build.product,
    version: leased.build.version,
    buildId: leased.build.buildId,
    packageId: leased.build.packageId,
    packageSecret: leased.build.packageSecret,
    packageManifestToken: leased.build.packageManifestToken,
    watermark: leased.build.watermark,
    domain: leased.build.domain,
  });
  const outputHash = output.sha256;
  app.artifactStore.put('jobs/fake-test.zip', output.buffer);
  const completed = app.portal.completeBuild('worker-test', job.id, {
    build_id: leased.build.buildId,
    artifact_ref: 'jobs/fake-test.zip',
    artifact_sha256: outputHash,
    install_key: leased.build.installKey,
    package_proof: leased.build.packageSecret,
  });
  assert.equal(completed.status, 'succeeded');
  const detail = app.portal.buildDetails(login.session, job.id);
  assert.equal(detail.install_key, leased.build.installKey);
  assert.equal(detail.artifact_sha256, outputHash);
  const overview = app.portal.customerOverview(login.session);
  assert.equal(overview.license.builds_used_last_24_hours, 1);
  assert.equal(overview.license.builds_remaining, 2);
  app.close();
});

test('主题 ZIP 自动识别 config.json 与文件名版本并拒绝冲突', (t) => {
  const app = setup();
  t.after(() => app.close());
  const sourceZip = writeZip(new Map([
    ['APPGOG-1.8.11-xboard/config.json', Buffer.from('{"name":"APPGOG","version":"1.8.11"}')],
    ['APPGOG-1.8.11-xboard/index.html', Buffer.from('<!doctype html><html><head></head><body>APPGOG</body></html>')],
  ]));
  const published = app.portal.publishSourceVersion({
    productCode: 'appgog', sourceFilename: 'APPGOG-1.8.11-xboard.zip', zipBuffer: sourceZip,
  });
  assert.equal(published.version, '1.8.11');
  assert.equal(published.display_name, 'APPGOG 1.8.11');
  assert.throws(() => app.portal.publishSourceVersion({
    productCode: 'appgog', version: '1.8.12', sourceFilename: 'APPGOG-1.8.11-xboard.zip', zipBuffer: sourceZip,
  }), /不一致/);
});

test('客户下载必须使用短期、不可篡改且绑定当前会话的票据', async (t) => {
  const app = setup();
  const issued = app.service.issueLicense({ customerRef: 'ORDER-DOWNLOAD', domain: 'download.example.com' });
  const product = app.repository.productByCode('appgog');
  const sourceZip = writeZip(new Map([
    ['APPGOG/config.json', Buffer.from('{"name":"APPGOG"}')],
    ['APPGOG/index.html', Buffer.from('<!doctype html><html><head></head><body>APPGOG</body></html>')],
  ]));
  app.artifactStore.put('sources/download.zip', sourceZip);
  app.repository.createSourceVersion({
    productId: product.id, version: '1.18.0', displayName: 'APPGOG 1.18.0', sourceKind: 'official',
    sourceRef: 'sources/download.zip', status: 'active', now: '2026-09-22T04:00:00.000Z',
  });
  const directSession = app.sessions.loginCustomer(issued.licenseKey).session;
  const job = app.portal.enqueueCustomerBuild(directSession, { version: '1.18.0', domain: 'download.example.com' });
  const leased = app.portal.leaseBuild('worker-download');
  const output = await app.buildEngine.build({
    sourceRef: leased.source.source_ref,
    product: leased.build.product,
    version: leased.build.version,
    buildId: leased.build.buildId,
    packageId: leased.build.packageId,
    packageSecret: leased.build.packageSecret,
    packageManifestToken: leased.build.packageManifestToken,
    watermark: leased.build.watermark,
    domain: leased.build.domain,
  });
  app.artifactStore.put('jobs/download.zip', output.buffer);
  app.portal.completeBuild('worker-download', job.id, {
    build_id: leased.build.buildId,
    artifact_ref: 'jobs/download.zip',
    artifact_sha256: output.sha256,
    install_key: leased.build.installKey,
    package_proof: leased.build.packageSecret,
  });

  const server = createServer(createHttpHandler({
    service: app.service, sessions: app.sessions, portal: app.portal, artifactStore: app.artifactStore,
    config: app.config, publicKey: app.publicKey.export({ type: 'spki', format: 'pem' }),
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function loginCustomer(licenseKey) {
    const response = await fetch(`${base}/web/customer/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ license_key: licenseKey }),
    });
    const data = await response.json();
    return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: data.csrf_token };
  }
  const customer = await loginCustomer(issued.licenseKey);
  const direct = await fetch(`${base}/web/customer/builds/${job.id}/download`, { headers: { cookie: customer.cookie } });
  assert.equal(direct.status, 403);
  assert.equal((await direct.json()).error.code, 'DOWNLOAD_TICKET_REQUIRED');

  const ticketResponse = await fetch(`${base}/web/customer/builds/${job.id}/download-ticket`, {
    method: 'POST', headers: { cookie: customer.cookie, 'x-csrf-token': customer.csrf },
  });
  assert.equal(ticketResponse.status, 201);
  const ticket = await ticketResponse.json();
  assert.match(ticket.download_url, /ticket=/);
  assert.ok(new Date(ticket.expires_at) > new Date());

  const download = await fetch(`${base}${ticket.download_url}`, { headers: { cookie: customer.cookie } });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('x-appgog-sha256'), output.sha256);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), output.buffer);

  const tamperedUrl = new URL(`${base}${ticket.download_url}`);
  const rawTicket = tamperedUrl.searchParams.get('ticket');
  tamperedUrl.searchParams.set('ticket', `${rawTicket.slice(0, -1)}${rawTicket.endsWith('a') ? 'b' : 'a'}`);
  const tampered = await fetch(tamperedUrl, { headers: { cookie: customer.cookie } });
  assert.equal(tampered.status, 403);
  assert.equal((await tampered.json()).error.code, 'DOWNLOAD_TICKET_INVALID');

  const other = app.service.issueLicense({ customerRef: 'ORDER-OTHER', domain: 'other.example.com' });
  const otherCustomer = await loginCustomer(other.licenseKey);
  const crossSession = await fetch(`${base}${ticket.download_url}`, { headers: { cookie: otherCustomer.cookie } });
  assert.equal(crossSession.status, 403);
  assert.equal((await crossSession.json()).error.code, 'DOWNLOAD_TICKET_INVALID');
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

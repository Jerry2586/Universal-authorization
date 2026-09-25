import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { bootstrap } from '../apps/license-api/src/bootstrap.js';
import { openDatabase } from '../apps/license-api/src/database.js';
import { createHttpHandler } from '../apps/license-api/src/http.js';
import { createBuildCenterHandler } from '../apps/build-center/src/server.js';
import { runWorkerOnce } from '../apps/build-worker/src/server.js';
import { LocalArtifactStore } from '../packages/adapters/src/local-artifact-store.js';
import { writeZip, readZip } from '../packages/core/src/zip.js';

test('分层部署：管理、客户和独立 Worker 的真实构建链路与访问边界', async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'appgog-split-test-'));
  const database = openDatabase(':memory:');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const config = {
    surface: 'license-center',
    internalServiceToken: 'test-internal-token-longer-than-32-characters',
    pepper: 'test-pepper-longer-than-32-characters',
    sessionSecret: 'test-session-secret-longer-than-32-characters',
    deliveryEncryptionKey: 'test-delivery-key-longer-than-32-characters',
    adminToken: 'test-admin-token-longer-than-32-characters',
    adminUsername: 'admin', adminPassword: 'test-password-for-admin',
    workerToken: 'test-worker-token-longer-than-32-characters',
    publicBaseUrl: 'http://127.0.0.1:8787',
    activationTokenTtlSeconds: 604800,
    buildTicketTtlSeconds: 900,
    webSessionTtlSeconds: 28800,
    maxSourceUploadBytes: 1024 * 1024,
    artifactRoot: join(tempRoot, 'artifacts'),
  };
  const app = bootstrap({ database, config, privateKey, publicKey: publicKeyPem });
  const buildNode = app.portal.createServiceNode({ name: '独立打包中心', role: 'build-center', public_url: 'https://build.example.com' }, 'test-owner');
  const workerNode = app.portal.createServiceNode({ name: '独立构建节点', role: 'worker' }, 'test-owner');
  const workerSockets = [];
  const handler = createHttpHandler({ ...app, config, publicKey: publicKeyPem });
  const center = createServer((request, response) => {
    if (request.url.startsWith('/api/v1/worker/')) workerSockets.push(request.socket);
    return handler(request, response);
  });
  center.listen(0, '127.0.0.1');
  await once(center, 'listening');
  const centerUrl = `http://127.0.0.1:${center.address().port}`;
  const build = createServer(createBuildCenterHandler({ internalUrl: centerUrl, nodeToken: buildNode.credential }));
  build.listen(0, '127.0.0.1');
  await once(build, 'listening');
  const buildUrl = `http://127.0.0.1:${build.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => build.close(resolve));
    await new Promise((resolve) => center.close(resolve));
    database.close();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const send = async (base, path, { method = 'GET', body, cookie, csrf, zip } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body ? { 'content-type': zip ? 'application/zip' : 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
      },
      ...(body ? { body: zip ? body : JSON.stringify(body) } : {}),
    });
    return { status: response.status, cookie: response.headers.get('set-cookie'), data: await response.json() };
  };
  assert.equal((await fetch(`${buildUrl}/health`)).status, 200);
  assert.equal((await fetch(`${buildUrl}/admin`)).status, 404);
  assert.equal((await fetch(`${centerUrl}/build`)).status, 404);
  assert.equal((await send(centerUrl, '/web/customer/overview')).status, 403);
  assert.equal((await fetch(`${buildUrl}/build`)).status, 200);

  const adminLogin = await send(centerUrl, '/web/admin/login', { method: 'POST', body: { username: 'admin', password: config.adminPassword } });
  assert.equal(adminLogin.status, 200);
  const adminCookie = adminLogin.cookie.split(';')[0];
  const adminCsrf = adminLogin.data.csrf_token;
  const sourceZip = writeZip(new Map([
    ['APPGOG/config.json', Buffer.from('{"name":"APPGOG"}')],
    ['APPGOG/index.html', Buffer.from('<!doctype html><html><head></head><body>APPGOG</body></html>')],
  ]));
  const upload = await send(centerUrl, '/web/admin/versions/upload?version=1.0.0', { method: 'POST', body: sourceZip, cookie: adminCookie, csrf: adminCsrf, zip: true });
  assert.equal(upload.status, 201);
  const issued = await send(centerUrl, '/web/admin/licenses', { method: 'POST', cookie: adminCookie, csrf: adminCsrf, body: { customer_ref: 'ORDER-SPLIT', domain: 'example.com' } });
  assert.equal(issued.status, 201);
  const customerLogin = await send(buildUrl, '/web/customer/login', { method: 'POST', body: { license_key: issued.data.license_key } });
  assert.equal(customerLogin.status, 200);
  const customerCookie = customerLogin.cookie.split(';')[0];
  const customerCsrf = customerLogin.data.csrf_token;
  const queued = await send(buildUrl, '/web/customer/builds', { method: 'POST', body: { version: '1.0.0', domain: 'example.com' }, cookie: customerCookie, csrf: customerCsrf });
  assert.equal(queued.status, 201);
  assert.equal(queued.data.status, 'queued');

  const remoteWorkerStore = new LocalArtifactStore(join(tempRoot, 'worker-artifacts'));
  const worked = await runWorkerOnce({
    baseUrl: centerUrl, token: workerNode.credential, workerId: 'ignored-request-worker-id',
    artifactStore: remoteWorkerStore, publicKey: publicKeyPem, publicBaseUrl: centerUrl, remoteTransfer: true,
  });
  assert.equal(worked, true);
  // Lease, two progress reports, source, artifact and completion each get a
  // fresh connection: CPU-heavy work must not leave a stale pooled socket.
  assert.equal(workerSockets.length, 6);
  assert.equal(new Set(workerSockets).size, 6);
  const storedJob = app.repository.buildJobById(queued.data.id);
  assert.equal(storedJob.lease_owner, workerNode.node.id);
  const detail = await send(buildUrl, `/web/customer/builds/${queued.data.id}`, { cookie: customerCookie });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.status, 'succeeded');
  assert.match(detail.data.install_key, /^INS-/);
  const ticket = await send(buildUrl, `/web/customer/builds/${queued.data.id}/download-ticket`, {
    method: 'POST', cookie: customerCookie, csrf: customerCsrf,
  });
  assert.equal(ticket.status, 201);
  const result = await fetch(`${buildUrl}${ticket.data.download_url}`, { headers: { cookie: customerCookie } });
  assert.equal(result.status, 200);
  const output = Buffer.from(await result.arrayBuffer());
  assert.equal(createHash('sha256').update(output).digest('hex'), result.headers.get('x-appgog-sha256'));
  assert.ok([...readZip(output).keys()].some((path) => /appgog-license\/p-[a-f0-9]+\/r-[a-f0-9]+\.js$/.test(path)));
  assert.equal((await send(buildUrl, '/web/admin/overview', { cookie: customerCookie })).status, 404);
});


test('Worker 源码下载失败记录阶段和错误码，不泄露凭证', async () => {
  const reports = [];
  const fetchImpl = async (url, options) => {
    assert.ok(options.signal);
    if (url.pathname.endsWith('/lease')) return Response.json({ task: { job: { id: 'job-network' }, source: {}, build: {} } });
    if (url.pathname.endsWith('/source')) throw new TypeError('fetch failed secret-token', { cause: { code: 'ECONNREFUSED', message: 'secret-token' } });
    if (url.pathname.endsWith('/fail')) reports.push(JSON.parse(options.body));
    return Response.json({});
  };
  await assert.rejects(runWorkerOnce({ baseUrl: 'https://license.example.com', token: 'secret-token', workerId: 'worker-test', remoteTransfer: true, fetchImpl }), (error) => {
    assert.equal(error.code, 'WORKER_ECONNREFUSED');
    assert.match(error.message, /下载主题源码/);
    assert.doesNotMatch(error.message, /secret-token/);
    return true;
  });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].code, 'WORKER_ECONNREFUSED');
});

test('Worker 领取请求超时会结束，不无限等待', async () => {
  const server = createServer(() => {}); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    await assert.rejects(runWorkerOnce({ baseUrl: 'http://127.0.0.1:' + server.address().port, token: 'test', workerId: 'timeout', requestTimeoutMs: 30 }), { code: 'WORKER_TIMEOUT' });
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});


test('Worker 下载响应体停滞也返回阶段超时诊断', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    await assert.rejects(runWorkerOnce({ baseUrl: 'http://127.0.0.1:' + server.address().port, token: 'test', workerId: 'body-timeout', requestTimeoutMs: 100 }), (error) => {
      assert.equal(error.code, 'WORKER_TIMEOUT'); assert.match(error.message, /领取构建任务/); return true;
    });
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

 test('Worker 不重试响应丢失的领取请求，避免重复领取任务', async (t) => {
  let calls = 0;
  const server = createServer((request) => { calls++; request.resume(); request.socket.destroy(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  await assert.rejects(runWorkerOnce({ baseUrl: 'http://127.0.0.1:' + server.address().port, token: 'test', workerId: 'lost-response' }), { code: 'WORKER_UND_ERR_SOCKET' });
  assert.equal(calls, 1);
});

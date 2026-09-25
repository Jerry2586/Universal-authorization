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
  const center = createServer(createHttpHandler({ ...app, config, publicKey: publicKeyPem }));
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

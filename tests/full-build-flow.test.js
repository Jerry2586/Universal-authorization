import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { bootstrap } from '../apps/license-api/src/bootstrap.js';
import { openDatabase } from '../apps/license-api/src/database.js';
import { readZip, writeZip } from '../packages/core/src/zip.js';
import { verifyActivation } from '../packages/appgog-sdk/src/verifier.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'appgog-full-build-'));
  const database = openDatabase(':memory:');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const config = {
    pepper: 'full-build-pepper-that-is-longer-than-thirty-two-chars',
    sessionSecret: 'full-build-session-secret-longer-than-thirty-two',
    deliveryEncryptionKey: 'full-build-delivery-key-longer-than-thirty-two',
    adminToken: 'full-build-admin-token',
    adminUsername: 'admin',
    adminPassword: 'full-build-admin-password',
    workerToken: 'full-build-worker-token',
    publicBaseUrl: 'https://license.example.com',
    activationTokenTtlSeconds: 604800,
    buildTicketTtlSeconds: 900,
    webSessionTtlSeconds: 28800,
    maxSourceUploadBytes: 128 * 1024 * 1024,
    artifactRoot: join(root, 'artifacts'),
    uploadRoot: join(root, 'uploads'),
  };
  const core = bootstrap({ database, config, privateKey, publicKey: publicKeyPem, clock: () => new Date('2026-09-22T08:00:00.000Z') });
  return {
    ...core, database, config, publicKey, root,
    close() { database.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test('完整成品链路：上传主题 ZIP、注入授权门、生成 ZIP、一次性 Key 激活', async () => {
  const app = fixture();
  const source = writeZip(new Map([
    ['APPGOG/config.json', Buffer.from('{"name":"APPGOG","version":"1.17.0"}')],
    ['APPGOG/index.html', Buffer.from('<!doctype html><html><head><title>APPGOG</title></head><body><main>Theme</main></body></html>')],
    ['APPGOG/dashboard.blade.php', Buffer.from('<!doctype html><html><head></head><body>Dashboard</body></html>')],
    ['APPGOG/assets/app.js', Buffer.from('console.log("appgog")')],
  ]));
  const version = app.portal.publishSourceVersion({
    version: '1.17.0', displayName: 'APPGOG 1.17.0', zipBuffer: source,
  });
  assert.equal(version.status, 'active');

  const issued = app.service.issueLicense({ customerRef: 'ORDER-FULL-1', domain: 'demo.example.com' });
  const customer = app.sessions.loginCustomer(issued.licenseKey).session;
  const job = app.portal.enqueueCustomerBuild(customer, { version: '1.17.0', domain: 'demo.example.com' });
  const leased = app.portal.leaseBuild('worker-full-test');
  assert.equal(leased.job.id, job.id);

  const result = await app.buildEngine.build({
    sourceRef: leased.source.source_ref,
    product: leased.build.product,
    version: leased.build.version,
    buildId: leased.build.buildId,
    packageId: leased.build.packageId,
    packageSecret: leased.build.packageSecret,
    domain: leased.build.domain,
  });
  const artifactRef = `builds/${job.id}/APPGOG.zip`;
  app.artifactStore.put(artifactRef, result.buffer);
  app.portal.completeBuild('worker-full-test', job.id, {
    build_id: leased.build.buildId,
    artifact_ref: artifactRef,
    artifact_sha256: result.sha256,
    install_key: leased.build.installKey,
  });

  const output = readZip(app.artifactStore.read(artifactRef));
  const index = output.get('APPGOG/index.html').toString('utf8');
  const dashboard = output.get('APPGOG/dashboard.blade.php').toString('utf8');
  assert.match(index, /data-appgog-license-runtime/);
  assert.match(dashboard, /data-appgog-license-runtime/);
  const runtimeName = [...output.keys()].find((name) => /appgog-license\/runtime\..+\.js$/.test(name));
  assert.ok(runtimeName);
  const runtime = output.get(runtimeName).toString('utf8');
  assert.match(runtime, /APPGOG 授权激活/);
  assert.match(runtime, /\/api\/v1\/activations/);
  const manifest = JSON.parse(output.get('APPGOG/appgog-license/build.json').toString('utf8'));
  assert.equal(manifest.build_id, leased.build.buildId);
  assert.equal(manifest.domain, 'demo.example.com');

  const activation = app.service.activate({
    installKey: leased.build.installKey,
    licenseKey: issued.licenseKey,
    buildId: leased.build.buildId,
    packageProof: leased.build.packageSecret,
    domain: 'demo.example.com',
    backendUrl: 'https://panel.example.com',
    installationId: 'installation_full_build_1',
  });
  const payload = verifyActivation({
    token: activation.token,
    publicKey: app.publicKey,
    domain: 'demo.example.com',
    backendUrl: 'https://panel.example.com',
    installationId: 'installation_full_build_1',
    now: new Date('2026-09-22T08:01:00.000Z'),
  });
  assert.equal(payload.package_id, leased.build.packageId);
  app.close();
});

test('上传安全检查拒绝普通 PHP 与缺少 Xboard 配置的 ZIP', () => {
  const app = fixture();
  const phpZip = writeZip(new Map([
    ['APPGOG/config.json', Buffer.from('{}')],
    ['APPGOG/index.html', Buffer.from('<html></html>')],
    ['APPGOG/shell.php', Buffer.from('<?php echo 1;')],
  ]));
  assert.throws(
    () => app.portal.publishSourceVersion({ version: 'bad-php', zipBuffer: phpZip }),
    (error) => error.code === 'SOURCE_PHP_REJECTED',
  );
  const missingConfig = writeZip(new Map([
    ['APPGOG/index.html', Buffer.from('<html></html>')],
    ['APPGOG/assets/app.js', Buffer.from('')],
  ]));
  assert.throws(
    () => app.portal.publishSourceVersion({ version: 'bad-config', zipBuffer: missingConfig }),
    (error) => error.code === 'SOURCE_CONFIG_NOT_FOUND',
  );
  app.close();
});

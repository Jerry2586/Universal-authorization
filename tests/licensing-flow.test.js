import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { createBuildInjection, restorePackageProof } from '../apps/build-worker/src/manifest.js';
import { bootstrap } from '../apps/license-api/src/bootstrap.js';
import { openDatabase } from '../apps/license-api/src/database.js';
import { verifyActivation } from '../packages/appgog-sdk/src/verifier.js';

function fixture() {
  const database = openDatabase(':memory:');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  let now = new Date('2026-09-22T00:00:00.000Z');
  const config = {
    pepper: 'test-pepper-that-is-definitely-longer-than-32-chars',
    publicBaseUrl: 'https://license.example.com',
    activationTokenTtlSeconds: 604800,
    buildTicketTtlSeconds: 900,
  };
  const core = bootstrap({ database, config, privateKey, clock: () => new Date(now) });
  return {
    database,
    publicKey,
    service: core.service,
    advance(milliseconds) { now = new Date(now.getTime() + milliseconds); },
  };
}

test('完整链路：固定 Key 打包、临时 Key 激活、SDK 本地验签', () => {
  const app = fixture();
  const issued = app.service.issueLicense({ customerRef: 'customer-001', domain: 'demo.example.com' });
  const authorization = app.service.authorizeBuild({
    licenseKey: issued.licenseKey,
    version: '1.17.0',
    domain: 'https://demo.example.com/',
  });
  const build = app.service.claimBuild({ buildTicket: authorization.buildTicket });
  const manifest = createBuildInjection({
    product: build.product,
    version: build.version,
    buildId: build.buildId,
    packageId: build.packageId,
    packageSecret: build.packageSecret,
    licenseServer: 'https://license.example.com',
    publicKey: app.publicKey.export({ type: 'spki', format: 'pem' }),
  });
  const installationId = 'installation_abcdef123456';
  const activation = app.service.activate({
    installKey: build.installKey,
    licenseKey: issued.licenseKey,
    buildId: build.buildId,
    packageProof: restorePackageProof(manifest),
    domain: 'demo.example.com',
    backendUrl: 'https://panel.example.com/',
    installationId,
  });
  const payload = verifyActivation({
    token: activation.token,
    publicKey: app.publicKey,
    domain: 'demo.example.com',
    backendUrl: 'https://panel.example.com',
    installationId,
    now: new Date('2026-09-22T00:01:00.000Z'),
  });
  assert.equal(payload.build_id, build.buildId);
  assert.equal(payload.package_id, build.packageId);
  app.database.close();
});

test('一次性安装 Key 不能重复使用', () => {
  const app = fixture();
  const issued = app.service.issueLicense({ customerRef: 'customer-002', domain: 'a.example.com' });
  const ticket = app.service.authorizeBuild({ licenseKey: issued.licenseKey, version: '1.0.0', domain: 'a.example.com' });
  const build = app.service.claimBuild({ buildTicket: ticket.buildTicket });
  const request = {
    installKey: build.installKey,
    licenseKey: issued.licenseKey,
    buildId: build.buildId,
    packageProof: build.packageSecret,
    domain: 'a.example.com',
    backendUrl: 'https://panel.example.com',
    installationId: 'installation_123456789',
  };
  app.service.activate(request);
  assert.throws(() => app.service.activate(request), (error) => error.code === 'INSTALL_KEY_USED');
  app.database.close();
});

test('固定 Key 不能为其他域名打包', () => {
  const app = fixture();
  const issued = app.service.issueLicense({ customerRef: 'customer-003', domain: 'a.example.com' });
  assert.throws(
    () => app.service.authorizeBuild({ licenseKey: issued.licenseKey, version: '1.0.0', domain: 'b.example.com' }),
    (error) => error.code === 'LICENSE_DOMAIN_MISMATCH',
  );
  app.database.close();
});

test('复制激活凭证到不同域名或环境会被 SDK 拒绝', () => {
  const app = fixture();
  const issued = app.service.issueLicense({ customerRef: 'customer-004', domain: 'a.example.com' });
  const ticket = app.service.authorizeBuild({ licenseKey: issued.licenseKey, version: '1.0.0', domain: 'a.example.com' });
  const build = app.service.claimBuild({ buildTicket: ticket.buildTicket });
  const activation = app.service.activate({
    installKey: build.installKey,
    licenseKey: issued.licenseKey,
    buildId: build.buildId,
    packageProof: build.packageSecret,
    domain: 'a.example.com',
    backendUrl: 'https://panel.example.com',
    installationId: 'installation_original_1',
  });
  assert.throws(
    () => verifyActivation({
      token: activation.token,
      publicKey: app.publicKey,
      domain: 'pirate.example.com',
      backendUrl: 'https://panel.example.com',
      installationId: 'installation_copied_2',
      now: new Date('2026-09-22T00:01:00.000Z'),
    }),
    (error) => error.code === 'DOMAIN_MISMATCH',
  );
  app.database.close();
});

test('轮换固定 Key 后旧 Key 无法打包，旧激活无法刷新', () => {
  const app = fixture();
  const issued = app.service.issueLicense({ customerRef: 'customer-005', domain: 'a.example.com' });
  const ticket = app.service.authorizeBuild({ licenseKey: issued.licenseKey, version: '1.0.0', domain: 'a.example.com' });
  const build = app.service.claimBuild({ buildTicket: ticket.buildTicket });
  const activation = app.service.activate({
    installKey: build.installKey,
    licenseKey: issued.licenseKey,
    buildId: build.buildId,
    packageProof: build.packageSecret,
    domain: 'a.example.com',
    backendUrl: 'https://panel.example.com',
    installationId: 'installation_rotate_1',
  });
  app.service.rotateLicenseKey({ licenseId: issued.license.id });
  assert.throws(
    () => app.service.authorizeBuild({ licenseKey: issued.licenseKey, version: '1.0.1', domain: 'a.example.com' }),
    (error) => error.code === 'LICENSE_NOT_FOUND',
  );
  assert.throws(
    () => app.service.refresh({
      activationId: activation.activationId,
      refreshSecret: activation.refreshSecret,
      domain: 'a.example.com',
      installationId: 'installation_rotate_1',
    }),
    (error) => error.code === 'LICENSE_ROTATED',
  );
  app.database.close();
});

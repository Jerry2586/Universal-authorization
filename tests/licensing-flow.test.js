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
    repository: core.repository,
    advance(milliseconds) { now = new Date(now.getTime() + milliseconds); },
  };
}

test('完整链路：固定 Key 打包、Install Key 解锁、固定 Key 激活、SDK 本地验签', () => {
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
  const receipt = app.service.unlockInstall({
    installKey: build.installKey,
    buildId: build.buildId,
    packageProof: restorePackageProof(manifest),
    domain: 'demo.example.com',
    backendUrl: 'https://panel.example.com/',
    installationId,
  });
  const activation = app.service.activate({
    licenseKey: issued.licenseKey,
    installReceiptId: receipt.receiptId,
    installReceiptSecret: receipt.receiptSecret,
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

test('一次性安装 Key 只能解锁一次，解锁后仍未正式激活', () => {
  const app = fixture();
  const issued = app.service.issueLicense({ customerRef: 'customer-002', domain: 'a.example.com' });
  const ticket = app.service.authorizeBuild({ licenseKey: issued.licenseKey, version: '1.0.0', domain: 'a.example.com' });
  const build = app.service.claimBuild({ buildTicket: ticket.buildTicket });
  const request = {
    installKey: build.installKey,
    buildId: build.buildId,
    packageProof: build.packageSecret,
    domain: 'a.example.com',
    backendUrl: 'https://panel.example.com',
    installationId: 'installation_123456789',
  };
  const receipt = app.service.unlockInstall(request);
  assert.match(receipt.receiptId, /^irc_/);
  assert.equal(app.database.prepare('SELECT status FROM builds WHERE id = ?').get(build.buildId).status, 'package_unlocked');
  assert.equal(app.database.prepare('SELECT COUNT(*) AS count FROM activations').get().count, 0);
  assert.throws(() => app.service.unlockInstall(request), (error) => error.code === 'INSTALL_KEY_USED');
  app.database.close();
});

test('Install Receipt 绑定 Build、域名、Origin 与 Installation ID，失败请求不会消费凭证', () => {
  const app = fixture();
  const issued = app.service.issueLicense({ customerRef: 'customer-receipt', domain: 'receipt.example.com' });
  const other = app.service.issueLicense({ customerRef: 'customer-other', domain: 'other.example.com' });
  const ticket = app.service.authorizeBuild({ licenseKey: issued.licenseKey, version: '1.0.0', domain: 'receipt.example.com' });
  const build = app.service.claimBuild({ buildTicket: ticket.buildTicket });
  const receipt = app.service.unlockInstall({
    installKey: build.installKey, buildId: build.buildId, packageProof: build.packageSecret,
    domain: 'receipt.example.com', backendUrl: 'https://panel.example.com',
    installationId: 'installation_receipt_1',
  });
  const request = {
    licenseKey: issued.licenseKey,
    installReceiptId: receipt.receiptId,
    installReceiptSecret: receipt.receiptSecret,
    buildId: build.buildId,
    packageProof: build.packageSecret,
    domain: 'receipt.example.com',
    backendUrl: 'https://panel.example.com',
    installationId: 'installation_receipt_1',
  };
  assert.throws(() => app.service.activate({ ...request, licenseKey: other.licenseKey }), (error) => error.code === 'LICENSE_KEY_MISMATCH');
  assert.throws(() => app.service.activate({ ...request, backendUrl: 'https://other-panel.example.com' }), (error) => error.code === 'BACKEND_MISMATCH');
  assert.throws(() => app.service.activate({ ...request, installationId: 'installation_receipt_2' }), (error) => error.code === 'INSTALLATION_MISMATCH');
  assert.equal(app.database.prepare('SELECT status FROM install_receipts WHERE id = ?').get(receipt.receiptId).status, 'unlocked');
  const activation = app.service.activate(request);
  assert.match(activation.token, /^[^.]+\.[^.]+\.[^.]+$/);
  assert.equal(app.database.prepare('SELECT status FROM install_receipts WHERE id = ?').get(receipt.receiptId).status, 'activated');
  assert.throws(() => app.service.activate(request), (error) => error.code === 'INSTALL_RECEIPT_USED');
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

test('固定 Key 错误、暂停、恢复与最终撤销均按状态机执行', () => {
  const app = fixture();
  const issued = app.service.issueLicense({ customerRef: 'customer-status', domain: 'status.example.com' });
  const ticket = app.service.authorizeBuild({
    licenseKey: issued.licenseKey, version: '1.0.0', domain: 'status.example.com',
  });
  const build = app.service.claimBuild({ buildTicket: ticket.buildTicket });
  const receipt = app.service.unlockInstall({
    installKey: build.installKey,
    buildId: build.buildId,
    packageProof: build.packageSecret,
    domain: 'status.example.com',
    backendUrl: 'https://panel.example.com',
    installationId: 'installation_status_1',
  });
  const activationRequest = {
    licenseKey: issued.licenseKey,
    installReceiptId: receipt.receiptId,
    installReceiptSecret: receipt.receiptSecret,
    buildId: build.buildId,
    packageProof: build.packageSecret,
    domain: 'status.example.com',
    backendUrl: 'https://panel.example.com',
    installationId: 'installation_status_1',
  };

  assert.throws(
    () => app.service.authorizeBuild({
      licenseKey: 'APPGOG-INVALID-LICENSE-KEY-000000000000', version: '1.0.0', domain: 'status.example.com',
    }),
    (error) => error.code === 'LICENSE_NOT_FOUND',
  );

  app.service.changeLicenseStatus({ licenseId: issued.license.id, status: 'suspended' });
  assert.throws(
    () => app.service.authorizeBuild({
      licenseKey: issued.licenseKey, version: '1.0.1', domain: 'status.example.com',
    }),
    (error) => error.code === 'LICENSE_INACTIVE',
  );
  assert.throws(() => app.service.activate(activationRequest), (error) => error.code === 'LICENSE_INACTIVE');
  assert.equal(
    app.database.prepare('SELECT status FROM install_receipts WHERE id = ?').get(receipt.receiptId).status,
    'unlocked',
  );

  app.service.changeLicenseStatus({ licenseId: issued.license.id, status: 'active' });
  const activation = app.service.activate(activationRequest);
  assert.match(activation.token, /^[^.]+\.[^.]+\.[^.]+$/);

  app.service.changeLicenseStatus({ licenseId: issued.license.id, status: 'revoked' });
  assert.throws(
    () => app.service.refresh({
      activationId: activation.activationId,
      refreshSecret: activation.refreshSecret,
      domain: 'status.example.com',
      backendUrl: 'https://panel.example.com',
      installationId: 'installation_status_1',
    }),
    (error) => error.code === 'LICENSE_INACTIVE',
  );
  assert.throws(
    () => app.service.changeLicenseStatus({ licenseId: issued.license.id, status: 'active' }),
    (error) => error.code === 'LICENSE_REVOKED_FINAL',
  );
  app.database.close();
});

test('其他产品的固定 Key 不能激活 APPGOG 包，失败不消费 Install Receipt', () => {
  const app = fixture();
  const issued = app.service.issueLicense({ customerRef: 'customer-appgog', domain: 'product.example.com' });
  const otherProduct = app.service.issueLicense({
    productCode: 'other-product', customerRef: 'customer-other-product', domain: 'product.example.com',
  });
  const ticket = app.service.authorizeBuild({
    licenseKey: issued.licenseKey, version: '1.0.0', domain: 'product.example.com',
  });
  const build = app.service.claimBuild({ buildTicket: ticket.buildTicket });
  const receipt = app.service.unlockInstall({
    installKey: build.installKey,
    buildId: build.buildId,
    packageProof: build.packageSecret,
    domain: 'product.example.com',
    backendUrl: 'https://panel.example.com',
    installationId: 'installation_product_1',
  });

  assert.throws(
    () => app.service.activate({
      licenseKey: otherProduct.licenseKey,
      installReceiptId: receipt.receiptId,
      installReceiptSecret: receipt.receiptSecret,
      buildId: build.buildId,
      packageProof: build.packageSecret,
      domain: 'product.example.com',
      backendUrl: 'https://panel.example.com',
      installationId: 'installation_product_1',
    }),
    (error) => error.code === 'LICENSE_KEY_MISMATCH',
  );
  assert.equal(
    app.database.prepare('SELECT status FROM install_receipts WHERE id = ?').get(receipt.receiptId).status,
    'unlocked',
  );
  app.database.close();
});

test('复制激活凭证到不同域名或环境会被 SDK 拒绝', () => {
  const app = fixture();
  const issued = app.service.issueLicense({ customerRef: 'customer-004', domain: 'a.example.com' });
  const ticket = app.service.authorizeBuild({ licenseKey: issued.licenseKey, version: '1.0.0', domain: 'a.example.com' });
  const build = app.service.claimBuild({ buildTicket: ticket.buildTicket });
  const receipt = app.service.unlockInstall({
    installKey: build.installKey,
    buildId: build.buildId,
    packageProof: build.packageSecret,
    domain: 'a.example.com',
    backendUrl: 'https://panel.example.com',
    installationId: 'installation_original_1',
  });
  const activation = app.service.activate({
    licenseKey: issued.licenseKey,
    installReceiptId: receipt.receiptId,
    installReceiptSecret: receipt.receiptSecret,
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
  const receipt = app.service.unlockInstall({
    installKey: build.installKey,
    buildId: build.buildId,
    packageProof: build.packageSecret,
    domain: 'a.example.com',
    backendUrl: 'https://panel.example.com',
    installationId: 'installation_rotate_1',
  });
  const activation = app.service.activate({
    licenseKey: issued.licenseKey,
    installReceiptId: receipt.receiptId,
    installReceiptSecret: receipt.receiptSecret,
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

test('最大激活环境数为 1 时拒绝第二个环境，且不消费其 Install Receipt', () => {
  const app = fixture();
  const issued = app.service.issueLicense({
    customerRef: 'customer-limit', domain: 'limit.example.com', maxBuildsPerDay: 3, maxActivations: 1,
  });

  function prepare(environment, backendUrl) {
    const ticket = app.service.authorizeBuild({
      licenseKey: issued.licenseKey, version: '1.0.0', domain: 'limit.example.com',
    });
    const build = app.service.claimBuild({ buildTicket: ticket.buildTicket });
    const receipt = app.service.unlockInstall({
      installKey: build.installKey, buildId: build.buildId, packageProof: build.packageSecret,
      domain: 'limit.example.com', backendUrl, installationId: environment,
    });
    return { build, receipt, request: {
      licenseKey: issued.licenseKey,
      installReceiptId: receipt.receiptId,
      installReceiptSecret: receipt.receiptSecret,
      buildId: build.buildId,
      packageProof: build.packageSecret,
      domain: 'limit.example.com',
      backendUrl,
      installationId: environment,
    } };
  }

  const first = prepare('installation_limit_first', 'https://panel-one.example.com');
  app.service.activate(first.request);
  const second = prepare('installation_limit_second', 'https://panel-two.example.com');
  assert.throws(() => app.service.activate(second.request), (error) => error.code === 'ACTIVATION_LIMIT_REACHED');
  assert.equal(app.database.prepare('SELECT status FROM install_receipts WHERE id = ?').get(second.receipt.receiptId).status, 'unlocked');
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM activations WHERE status = 'active'").get().count, 1);
  app.database.close();
});

test('域名迁移后旧 Activation 无法刷新并返回明确的域名迁移错误', () => {
  const app = fixture();
  const issued = app.service.issueLicense({ customerRef: 'customer-domain-move', domain: 'old.example.com' });
  const ticket = app.service.authorizeBuild({ licenseKey: issued.licenseKey, version: '1.0.0', domain: 'old.example.com' });
  const build = app.service.claimBuild({ buildTicket: ticket.buildTicket });
  const receipt = app.service.unlockInstall({
    installKey: build.installKey, buildId: build.buildId, packageProof: build.packageSecret,
    domain: 'old.example.com', backendUrl: 'https://panel.example.com', installationId: 'installation_domain_move',
  });
  const activation = app.service.activate({
    licenseKey: issued.licenseKey, installReceiptId: receipt.receiptId,
    installReceiptSecret: receipt.receiptSecret, buildId: build.buildId, packageProof: build.packageSecret,
    domain: 'old.example.com', backendUrl: 'https://panel.example.com', installationId: 'installation_domain_move',
  });
  app.service.changeLicenseDomain({ licenseId: issued.license.id, domain: 'new.example.com' });
  assert.throws(
    () => app.service.refresh({
      activationId: activation.activationId,
      refreshSecret: activation.refreshSecret,
      domain: 'old.example.com',
      backendUrl: 'https://panel.example.com',
      installationId: 'installation_domain_move',
    }),
    (error) => error.code === 'LICENSE_DOMAIN_MISMATCH',
  );
  app.database.close();
});

test('客户可首次绑定域名并提交受控迁移，管理员批准后 generation 增加', () => {
  const app = fixture();
  const issued = app.service.issueLicense({ customerRef: 'customer-domain-workflow' });
  const bound = app.service.bindLicenseDomain({
    licenseId: issued.license.id, domain: 'https://WWW.First.Example.com/', actorId: issued.license.id,
  });
  assert.equal(bound.bound_domain, 'first.example.com');
  assert.throws(
    () => app.service.bindLicenseDomain({ licenseId: issued.license.id, domain: 'other.example.com' }),
    (error) => error.code === 'DOMAIN_ALREADY_BOUND',
  );

  const migration = app.service.requestDomainMigration({
    licenseId: issued.license.id,
    domain: 'second.example.com',
    reason: '客户业务品牌升级，需要迁移到新的正式域名',
  });
  assert.equal(migration.status, 'pending');
  assert.equal(migration.previous_domain, 'first.example.com');
  assert.equal(migration.requested_domain, 'second.example.com');
  assert.throws(
    () => app.service.requestDomainMigration({
      licenseId: issued.license.id, domain: 'third.example.com', reason: '另一个同时提交的迁移申请',
    }),
    (error) => error.code === 'DOMAIN_MIGRATION_PENDING',
  );

  const admin = app.repository.listAdmins()[0];
  const reviewed = app.service.reviewDomainMigration({
    requestId: migration.id, decision: 'approved', reviewerId: admin.id, reviewNote: '已核验客户迁移安排',
  });
  assert.equal(reviewed.request.status, 'approved');
  assert.equal(reviewed.license.bound_domain, 'second.example.com');
  assert.equal(reviewed.license.generation, 2);
  assert.throws(
    () => app.service.reviewDomainMigration({ requestId: migration.id, decision: 'approved', reviewerId: admin.id }),
    (error) => error.code === 'DOMAIN_MIGRATION_REVIEWED',
  );
  app.database.close();
});

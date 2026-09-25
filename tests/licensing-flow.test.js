import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { createBuildInjection, restorePackageProof } from '../apps/build-worker/src/manifest.js';
import { bootstrap } from '../apps/license-api/src/bootstrap.js';
import { openDatabase } from '../apps/license-api/src/database.js';
import { verifyActivation } from '../packages/appgog-sdk/src/verifier.js';
import { requireActivation } from '../packages/appgog-sdk/src/guard.js';
import { signInstallationChallenge } from '../packages/appgog-sdk/src/installation-identity.js';
import { installationFingerprint, installationIdFromPublicKey } from '../packages/core/src/installation-proof.js';
import { verifyCompactToken } from '../packages/core/src/signing.js';

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

test('Activation、Package 与 Notification 使用独立签名密钥且不能交叉验签', () => {
  const database = openDatabase(':memory:');
  const activation = generateKeyPairSync('ed25519');
  const packageKeys = generateKeyPairSync('ed25519');
  const notification = generateKeyPairSync('ed25519');
  const publicPem = (pair) => pair.publicKey.export({ type: 'spki', format: 'pem' });
  const config = {
    pepper: 'separated-signing-pepper-longer-than-thirty-two-chars',
    publicBaseUrl: 'https://license.example.com',
    buildCenterPublicUrl: 'https://build.example.com/build',
    activationTokenTtlSeconds: 604800,
    buildTicketTtlSeconds: 900,
  };
  const app = bootstrap({
    database,
    config,
    keyring: {
      activation: { privateKey: activation.privateKey, publicKey: publicPem(activation) },
      package: { privateKey: packageKeys.privateKey, publicKey: publicPem(packageKeys) },
      notification: { privateKey: notification.privateKey, publicKey: publicPem(notification) },
    },
    clock: () => new Date('2026-09-24T00:00:00.000Z'),
  });
  const product = app.service.ensureProduct();
  app.repository.createSourceVersion({
    productId: product.id, version: '2.0.0', displayName: 'APPGOG 2.0.0', sourceKind: 'official',
    sourceRef: 'sources/appgog/2.0.0/source.zip', status: 'active', releaseNotes: '密钥隔离测试',
    channel: 'stable', releaseKind: 'security', rollbackAllowed: false, now: '2026-09-24T00:00:00.000Z',
  });
  const issued = app.service.issueLicense({ customerRef: 'keyring-test', domain: 'keyring.example.com' });
  const authorization = app.service.authorizeBuild({ licenseKey: issued.licenseKey, version: '2.0.0', domain: 'keyring.example.com' });
  const build = app.service.claimBuild({ buildTicket: authorization.buildTicket });
  const receipt = app.service.unlockInstall({
    installKey: build.installKey, buildId: build.buildId, packageProof: build.packageSecret,
    domain: 'keyring.example.com', backendUrl: 'https://panel.example.com', installationId: 'ins_keyring_test',
  });
  const activated = app.service.activate({
    licenseKey: issued.licenseKey, installReceiptId: receipt.receiptId, installReceiptSecret: receipt.receiptSecret,
    buildId: build.buildId, packageProof: build.packageSecret, domain: 'keyring.example.com',
    backendUrl: 'https://panel.example.com', installationId: 'ins_keyring_test',
  });
  const release = app.service.releaseAnnouncement();

  assert.equal(verifyCompactToken(activated.token, activation.publicKey).typ, 'activation');
  assert.equal(verifyCompactToken(build.packageManifestToken, packageKeys.publicKey).typ, 'package-manifest');
  assert.equal(verifyCompactToken(release.release_token, notification.publicKey).typ, 'release');
  assert.throws(() => verifyCompactToken(activated.token, packageKeys.publicKey));
  assert.throws(() => verifyCompactToken(build.packageManifestToken, notification.publicKey));
  assert.throws(() => verifyCompactToken(release.release_token, activation.publicKey));
  database.close();
});

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

test('免费版能力写入签名激活凭证，SDK 在产品后端强制拒绝付费能力', () => {
  const app = fixture();
  const issued = app.service.issueLicense({ customerRef: 'customer-free', domain: 'free.example.com', planCode: 'free' });
  app.database.prepare(`UPDATE license_plans SET capabilities_json = ? WHERE code = 'free'`).run(
    JSON.stringify(['settings:read', 'settings:write', 'updates:read']),
  );
  const authorization = app.service.authorizeBuild({ licenseKey: issued.licenseKey, version: '1.0.0', domain: 'free.example.com' });
  const build = app.service.claimBuild({ buildTicket: authorization.buildTicket });
  const installationId = 'installation_free_123456';
  const receipt = app.service.unlockInstall({
    installKey: build.installKey, buildId: build.buildId, packageProof: build.packageSecret,
    domain: 'free.example.com', backendUrl: 'https://panel.example.com', installationId,
  });
  const activation = app.service.activate({
    licenseKey: issued.licenseKey, installReceiptId: receipt.receiptId,
    installReceiptSecret: receipt.receiptSecret, buildId: build.buildId,
    packageProof: build.packageSecret, domain: 'free.example.com',
    backendUrl: 'https://panel.example.com', installationId,
  });
  const common = {
    token: activation.token, publicKey: app.publicKey, domain: 'free.example.com',
    backendUrl: 'https://panel.example.com', installationId,
    now: new Date('2026-09-22T00:01:00.000Z'),
  };
  const payload = requireActivation({ ...common, capability: 'settings:read' });
  assert.equal(payload.plan, 'free');
  assert.ok(payload.capabilities.includes('settings:read'));
  assert.ok(!payload.capabilities.includes('settings:write'));
  assert.deepEqual(payload.limits, { max_builds_per_day: 1, max_activations: 1 });
  assert.throws(() => requireActivation({ ...common, capability: 'settings:write' }), (error) => error.code === 'APPGOG_CAPABILITY_DENIED');
  app.database.close();
});

test('套餐切换原子更新能力与额度快照，并使旧激活立即失效', () => {
  const app = fixture();
  const issued = app.service.issueLicense({ customerRef: 'customer-plan-change', domain: 'plan.example.com', planCode: 'free' });
  const authorization = app.service.authorizeBuild({
    licenseKey: issued.licenseKey, version: '1.0.0', domain: 'plan.example.com',
  });
  const build = app.service.claimBuild({ buildTicket: authorization.buildTicket });
  const installationId = 'installation_plan_change';
  const receipt = app.service.unlockInstall({
    installKey: build.installKey, buildId: build.buildId, packageProof: build.packageSecret,
    domain: 'plan.example.com', backendUrl: 'https://panel.example.com', installationId,
  });
  const activation = app.service.activate({
    licenseKey: issued.licenseKey, installReceiptId: receipt.receiptId,
    installReceiptSecret: receipt.receiptSecret, buildId: build.buildId,
    packageProof: build.packageSecret, domain: 'plan.example.com',
    backendUrl: 'https://panel.example.com', installationId,
  });
  const changed = app.service.changeLicensePlan({ licenseId: issued.license.id, planCode: 'paid', actorId: 'adm_owner' });
  assert.equal(changed.plan_code, 'paid');
  assert.equal(changed.max_builds_per_day, 10);
  assert.equal(changed.max_activations, 3);
  assert.ok(JSON.parse(changed.entitlement_capabilities_json).includes('settings:write'));
  assert.deepEqual(JSON.parse(changed.entitlement_limits_json), { max_builds_per_day: 10, max_activations: 3 });
  assert.throws(() => app.service.refresh({
    activationId: activation.activationId, refreshSecret: activation.refreshSecret,
    domain: 'plan.example.com', backendUrl: 'https://panel.example.com', installationId,
  }), (error) => ['ACTIVATION_INACTIVE', 'LICENSE_ROTATED'].includes(error.code));
  app.database.close();
});

test('服务器 Ed25519 安装身份使用一次性挑战证明，重放和复制 Installation ID 均被拒绝', () => {
  const app = fixture();
  const issued = app.service.issueLicense({ customerRef: 'customer-proof', domain: 'proof.example.com' });
  const authorization = app.service.authorizeBuild({ licenseKey: issued.licenseKey, version: '1.0.0', domain: 'proof.example.com' });
  const build = app.service.claimBuild({ buildTicket: authorization.buildTicket });
  const receipt = app.service.unlockInstall({
    installKey: build.installKey, buildId: build.buildId, packageProof: build.packageSecret,
    domain: 'proof.example.com', backendUrl: 'https://panel.example.com',
    installationId: 'placeholder-installation-id',
  });
  const identity = generateKeyPairSync('ed25519');
  const publicKeyPem = identity.publicKey.export({ type: 'spki', format: 'pem' });
  const installationId = installationIdFromPublicKey(publicKeyPem);
  app.database.prepare('UPDATE install_receipts SET installation_id = ? WHERE id = ?').run(installationId, receipt.receiptId);
  const context = {
    install_receipt_id: receipt.receiptId, build_id: build.buildId,
    domain: 'proof.example.com', backend_origin: 'https://panel.example.com',
  };
  const challenge = app.service.createInstallationChallenge({ purpose: 'activation', publicKey: publicKeyPem, context });
  const signature = signInstallationChallenge({ challenge, privateKey: identity.privateKey });
  const request = {
    licenseKey: issued.licenseKey, installReceiptId: receipt.receiptId,
    installReceiptSecret: receipt.receiptSecret, buildId: build.buildId,
    packageProof: build.packageSecret, domain: 'proof.example.com',
    backendUrl: 'https://panel.example.com', installationId,
    installationPublicKey: publicKeyPem, challengeId: challenge.id, challengeSignature: signature,
  };
  const activation = app.service.activate(request);
  const payload = verifyActivation({
    token: activation.token, publicKey: app.publicKey, domain: 'proof.example.com',
    backendUrl: 'https://panel.example.com', installationId,
    now: new Date('2026-09-22T00:01:00.000Z'),
  });
  assert.equal(payload.installation_identity_mode, 'server_key');
  assert.ok(payload.installation_public_key_fingerprint);
  assert.equal(app.repository.installationIdentityById(installationId).status, 'active');
  assert.throws(() => app.service.activate(request), (error) => ['INSTALL_RECEIPT_USED', 'INSTALLATION_CHALLENGE_USED'].includes(error.code));

  const attacker = generateKeyPairSync('ed25519');
  const attackerPublic = attacker.publicKey.export({ type: 'spki', format: 'pem' });
  const refreshContext = { activation_id: activation.activationId, domain: 'proof.example.com', backend_origin: 'https://panel.example.com' };
  const attackerChallenge = app.service.createInstallationChallenge({ purpose: 'refresh', publicKey: attackerPublic, context: refreshContext });
  assert.throws(() => app.service.refresh({
    activationId: activation.activationId, refreshSecret: activation.refreshSecret,
    domain: 'proof.example.com', backendUrl: 'https://panel.example.com', installationId,
    installationPublicKey: attackerPublic, challengeId: attackerChallenge.id,
    challengeSignature: signInstallationChallenge({ challenge: attackerChallenge, privateKey: attacker.privateKey }),
  }), (error) => error.code === 'INSTALLATION_IDENTITY_MISMATCH');
  app.database.close();
});

test('受控产品迁机由旧服务器签发一次性 Grant，新服务器接管后旧实例立即 Fenced', () => {
  const app = fixture();
  const issued = app.service.issueLicense({ customerRef: 'customer-move', domain: 'move.example.com' });
  const authorization = app.service.authorizeBuild({ licenseKey: issued.licenseKey, version: '1.0.0', domain: 'move.example.com' });
  const build = app.service.claimBuild({ buildTicket: authorization.buildTicket });
  const sourceKeys = generateKeyPairSync('ed25519');
  const sourcePublicKey = sourceKeys.publicKey.export({ type: 'spki', format: 'pem' });
  const sourceInstallationId = installationIdFromPublicKey(sourcePublicKey);
  const receipt = app.service.unlockInstall({
    installKey: build.installKey, buildId: build.buildId, packageProof: build.packageSecret,
    domain: 'move.example.com', backendUrl: 'https://panel.example.com', installationId: sourceInstallationId,
  });
  const activationContext = {
    install_receipt_id: receipt.receiptId, build_id: build.buildId,
    domain: 'move.example.com', backend_origin: 'https://panel.example.com',
  };
  const activationChallenge = app.service.createInstallationChallenge({ purpose: 'activation', publicKey: sourcePublicKey, context: activationContext });
  const sourceActivation = app.service.activate({
    licenseKey: issued.licenseKey, installReceiptId: receipt.receiptId,
    installReceiptSecret: receipt.receiptSecret, buildId: build.buildId,
    packageProof: build.packageSecret, domain: 'move.example.com', backendUrl: 'https://panel.example.com',
    installationId: sourceInstallationId, installationPublicKey: sourcePublicKey,
    challengeId: activationChallenge.id,
    challengeSignature: signInstallationChallenge({ challenge: activationChallenge, privateKey: sourceKeys.privateKey }),
  });

  const targetKeys = generateKeyPairSync('ed25519');
  const targetPublicKey = targetKeys.publicKey.export({ type: 'spki', format: 'pem' });
  const issueContext = {
    activation_id: sourceActivation.activationId,
    target_public_key_fingerprint: installationFingerprint(targetPublicKey),
  };
  const issueChallenge = app.service.createInstallationChallenge({ purpose: 'migration_issue', publicKey: sourcePublicKey, context: issueContext });
  const grant = app.service.issueProductMigrationGrant({
    activationId: sourceActivation.activationId, refreshSecret: sourceActivation.refreshSecret,
    targetInstallationPublicKey: targetPublicKey, installationPublicKey: sourcePublicKey,
    challengeId: issueChallenge.id,
    challengeSignature: signInstallationChallenge({ challenge: issueChallenge, privateKey: sourceKeys.privateKey }),
  });
  assert.match(grant.grantToken, /^PMG_/);
  assert.notEqual(grant.targetInstallationId, sourceInstallationId);

  const acceptContext = {
    grant_id: grant.grantId, build_id: build.buildId,
    domain: 'move.example.com', backend_origin: 'https://panel.example.com',
  };
  const acceptChallenge = app.service.createInstallationChallenge({ purpose: 'migration_accept', publicKey: targetPublicKey, context: acceptContext });
  const targetActivation = app.service.acceptProductMigration({
    grantToken: grant.grantToken, buildId: build.buildId, packageProof: build.packageSecret,
    domain: 'move.example.com', backendUrl: 'https://panel.example.com',
    installationId: grant.targetInstallationId, installationPublicKey: targetPublicKey,
    challengeId: acceptChallenge.id,
    challengeSignature: signInstallationChallenge({ challenge: acceptChallenge, privateKey: targetKeys.privateKey }),
  });
  assert.equal(targetActivation.sourceStatus, 'fenced');
  assert.equal(targetActivation.targetStatus, 'active');
  assert.equal(app.repository.installationIdentityById(sourceInstallationId).status, 'fenced');
  assert.equal(app.repository.installationIdentityById(grant.targetInstallationId).status, 'active');
  assert.equal(app.repository.activationById(sourceActivation.activationId).status, 'fenced');
  assert.equal(app.repository.productMigrationGrantByHash('not-a-hash'), undefined);
  assert.throws(() => app.service.acceptProductMigration({
    grantToken: grant.grantToken, buildId: build.buildId, packageProof: build.packageSecret,
    domain: 'move.example.com', backendUrl: 'https://panel.example.com',
    installationId: grant.targetInstallationId, installationPublicKey: targetPublicKey,
    challengeId: acceptChallenge.id,
    challengeSignature: signInstallationChallenge({ challenge: acceptChallenge, privateKey: targetKeys.privateKey }),
  }), (error) => error.code === 'PRODUCT_MIGRATION_GRANT_USED');
  app.database.close();
});

test('产品迁机候选验证、唯一 Active 切换与窗口内回滚形成完整状态机', () => {
  const app = fixture();
  const issued = app.service.issueLicense({ customerRef: 'customer-move-state', domain: 'state-move.example.com' });
  const authorization = app.service.authorizeBuild({
    licenseKey: issued.licenseKey, version: '1.0.0', domain: 'state-move.example.com',
  });
  const build = app.service.claimBuild({ buildTicket: authorization.buildTicket });
  const sourceKeys = generateKeyPairSync('ed25519');
  const sourcePublicKey = sourceKeys.publicKey.export({ type: 'spki', format: 'pem' });
  const sourceInstallationId = installationIdFromPublicKey(sourcePublicKey);
  const receipt = app.service.unlockInstall({
    installKey: build.installKey, buildId: build.buildId, packageProof: build.packageSecret,
    domain: 'state-move.example.com', backendUrl: 'https://panel.example.com', installationId: sourceInstallationId,
  });
  const activationContext = {
    install_receipt_id: receipt.receiptId, build_id: build.buildId,
    domain: 'state-move.example.com', backend_origin: 'https://panel.example.com',
  };
  const activationChallenge = app.service.createInstallationChallenge({
    purpose: 'activation', publicKey: sourcePublicKey, context: activationContext,
  });
  const sourceActivation = app.service.activate({
    licenseKey: issued.licenseKey, installReceiptId: receipt.receiptId,
    installReceiptSecret: receipt.receiptSecret, buildId: build.buildId,
    packageProof: build.packageSecret, domain: 'state-move.example.com', backendUrl: 'https://panel.example.com',
    installationId: sourceInstallationId, installationPublicKey: sourcePublicKey,
    challengeId: activationChallenge.id,
    challengeSignature: signInstallationChallenge({ challenge: activationChallenge, privateKey: sourceKeys.privateKey }),
  });
  const reusedTargetKeys = generateKeyPairSync('ed25519');
  const reusedTargetPublicKey = reusedTargetKeys.publicKey.export({ type: 'spki', format: 'pem' });
  const reusedTargetInstallationId = installationIdFromPublicKey(reusedTargetPublicKey);
  app.repository.registerInstallationIdentity({
    installationId: reusedTargetInstallationId, licenseId: issued.license.id,
    publicKeyPem: reusedTargetPublicKey, publicKeyFingerprint: installationFingerprint(reusedTargetPublicKey),
    status: 'fenced', now: '2026-09-22T00:00:00.000Z',
  });
  const reusedIssueContext = {
    activation_id: sourceActivation.activationId,
    target_public_key_fingerprint: installationFingerprint(reusedTargetPublicKey),
  };
  const reusedIssueChallenge = app.service.createInstallationChallenge({
    purpose: 'migration_issue', publicKey: sourcePublicKey, context: reusedIssueContext,
  });
  assert.throws(() => app.service.issueProductMigrationGrant({
    activationId: sourceActivation.activationId, refreshSecret: sourceActivation.refreshSecret,
    targetInstallationPublicKey: reusedTargetPublicKey, installationPublicKey: sourcePublicKey,
    challengeId: reusedIssueChallenge.id,
    challengeSignature: signInstallationChallenge({ challenge: reusedIssueChallenge, privateKey: sourceKeys.privateKey }),
  }), (error) => error.code === 'MIGRATION_TARGET_IDENTITY_EXISTS');
  const targetKeys = generateKeyPairSync('ed25519');
  const targetPublicKey = targetKeys.publicKey.export({ type: 'spki', format: 'pem' });
  const issueContext = {
    activation_id: sourceActivation.activationId,
    target_public_key_fingerprint: installationFingerprint(targetPublicKey),
  };
  const issueChallenge = app.service.createInstallationChallenge({
    purpose: 'migration_issue', publicKey: sourcePublicKey, context: issueContext,
  });
  const grant = app.service.issueProductMigrationGrant({
    activationId: sourceActivation.activationId, refreshSecret: sourceActivation.refreshSecret,
    targetInstallationPublicKey: targetPublicKey, installationPublicKey: sourcePublicKey,
    challengeId: issueChallenge.id,
    challengeSignature: signInstallationChallenge({ challenge: issueChallenge, privateKey: sourceKeys.privateKey }),
  });

  const prepareContext = {
    grant_id: grant.grantId, build_id: build.buildId,
    domain: 'state-move.example.com', backend_origin: 'https://panel.example.com',
  };
  const prepareChallenge = app.service.createInstallationChallenge({
    purpose: 'migration_prepare', publicKey: targetPublicKey, context: prepareContext,
  });
  const prepared = app.service.prepareProductMigration({
    grantToken: grant.grantToken, buildId: build.buildId, packageProof: build.packageSecret,
    domain: 'state-move.example.com', backendUrl: 'https://panel.example.com',
    installationId: grant.targetInstallationId, installationPublicKey: targetPublicKey,
    challengeId: prepareChallenge.id,
    challengeSignature: signInstallationChallenge({ challenge: prepareChallenge, privateKey: targetKeys.privateKey }),
  });
  assert.equal(prepared.sourceStatus, 'active');
  assert.equal(prepared.targetStatus, 'candidate');
  assert.equal(app.repository.activationById(sourceActivation.activationId).status, 'active');
  assert.equal(app.repository.activationById(prepared.activationId).status, 'candidate');
  assert.equal(app.repository.installationIdentityById(grant.targetInstallationId).status, 'candidate');
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM activations WHERE license_id = ? AND status = 'active'").get(issued.license.id).count, 1);
  assert.throws(() => app.service.refresh({
    activationId: prepared.activationId, refreshSecret: prepared.refreshSecret,
    domain: 'state-move.example.com', backendUrl: 'https://panel.example.com',
    installationId: grant.targetInstallationId,
  }), (error) => error.code === 'ACTIVATION_INACTIVE');

  const commitContext = { grant_id: grant.grantId, target_activation_id: prepared.activationId };
  const commitChallenge = app.service.createInstallationChallenge({
    purpose: 'migration_commit', publicKey: targetPublicKey, context: commitContext,
  });
  const committed = app.service.commitProductMigration({
    grantToken: grant.grantToken, installationId: grant.targetInstallationId,
    installationPublicKey: targetPublicKey, challengeId: commitChallenge.id,
    challengeSignature: signInstallationChallenge({ challenge: commitChallenge, privateKey: targetKeys.privateKey }),
  });
  assert.equal(committed.sourceStatus, 'fenced');
  assert.equal(committed.targetStatus, 'active');
  assert.equal(app.repository.activationById(sourceActivation.activationId).status, 'fenced');
  assert.equal(app.repository.activationById(prepared.activationId).status, 'active');
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM activations WHERE license_id = ? AND status = 'active'").get(issued.license.id).count, 1);

  const rollbackContext = { grant_id: grant.grantId, phase: 'completed' };
  const rollbackChallenge = app.service.createInstallationChallenge({
    purpose: 'migration_rollback', publicKey: sourcePublicKey, context: rollbackContext,
  });
  app.database.prepare('UPDATE product_migration_grants SET rollback_until = ? WHERE id = ?')
    .run('2020-01-01T00:00:00.000Z', grant.grantId);
  assert.throws(() => app.service.rollbackProductMigration({
    grantToken: grant.grantToken, refreshSecret: sourceActivation.refreshSecret,
    reason: 'expired_window_must_fail', installationId: sourceInstallationId,
    installationPublicKey: sourcePublicKey, challengeId: rollbackChallenge.id,
    challengeSignature: signInstallationChallenge({ challenge: rollbackChallenge, privateKey: sourceKeys.privateKey }),
  }), (error) => error.code === 'PRODUCT_MIGRATION_ROLLBACK_EXPIRED');
  app.database.prepare('UPDATE product_migration_grants SET rollback_until = ? WHERE id = ?')
    .run(committed.rollbackUntil, grant.grantId);
  const rolledBack = app.service.rollbackProductMigration({
    grantToken: grant.grantToken, refreshSecret: sourceActivation.refreshSecret,
    reason: 'target_health_check_failed', installationId: sourceInstallationId,
    installationPublicKey: sourcePublicKey, challengeId: rollbackChallenge.id,
    challengeSignature: signInstallationChallenge({ challenge: rollbackChallenge, privateKey: sourceKeys.privateKey }),
  });
  assert.equal(rolledBack.sourceStatus, 'active');
  assert.equal(rolledBack.targetStatus, 'fenced');
  assert.equal(app.repository.activationById(sourceActivation.activationId).status, 'active');
  assert.equal(app.repository.activationById(prepared.activationId).status, 'fenced');
  assert.equal(app.repository.installationIdentityById(sourceInstallationId).status, 'active');
  assert.equal(app.repository.installationIdentityById(grant.targetInstallationId).status, 'fenced');
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM activations WHERE license_id = ? AND status = 'active'").get(issued.license.id).count, 1);
  assert.throws(() => app.service.rollbackProductMigration({
    grantToken: grant.grantToken, refreshSecret: sourceActivation.refreshSecret,
    installationId: sourceInstallationId, installationPublicKey: sourcePublicKey,
    challengeId: rollbackChallenge.id,
    challengeSignature: signInstallationChallenge({ challenge: rollbackChallenge, privateKey: sourceKeys.privateKey }),
  }), (error) => error.code === 'PRODUCT_MIGRATION_NOT_ROLLBACKABLE');
  app.database.close();
});

test('产品迁机候选可在切换前撤销，源实例持续 Active', () => {
  const app = fixture();
  const issued = app.service.issueLicense({ customerRef: 'customer-move-cancel', domain: 'cancel-move.example.com' });
  const authorization = app.service.authorizeBuild({
    licenseKey: issued.licenseKey, version: '1.0.0', domain: 'cancel-move.example.com',
  });
  const build = app.service.claimBuild({ buildTicket: authorization.buildTicket });
  const sourceKeys = generateKeyPairSync('ed25519');
  const sourcePublicKey = sourceKeys.publicKey.export({ type: 'spki', format: 'pem' });
  const sourceInstallationId = installationIdFromPublicKey(sourcePublicKey);
  const receipt = app.service.unlockInstall({
    installKey: build.installKey, buildId: build.buildId, packageProof: build.packageSecret,
    domain: 'cancel-move.example.com', backendUrl: 'https://panel.example.com', installationId: sourceInstallationId,
  });
  const activationContext = {
    install_receipt_id: receipt.receiptId, build_id: build.buildId,
    domain: 'cancel-move.example.com', backend_origin: 'https://panel.example.com',
  };
  const activationChallenge = app.service.createInstallationChallenge({
    purpose: 'activation', publicKey: sourcePublicKey, context: activationContext,
  });
  const sourceActivation = app.service.activate({
    licenseKey: issued.licenseKey, installReceiptId: receipt.receiptId,
    installReceiptSecret: receipt.receiptSecret, buildId: build.buildId,
    packageProof: build.packageSecret, domain: 'cancel-move.example.com', backendUrl: 'https://panel.example.com',
    installationId: sourceInstallationId, installationPublicKey: sourcePublicKey,
    challengeId: activationChallenge.id,
    challengeSignature: signInstallationChallenge({ challenge: activationChallenge, privateKey: sourceKeys.privateKey }),
  });
  const targetKeys = generateKeyPairSync('ed25519');
  const targetPublicKey = targetKeys.publicKey.export({ type: 'spki', format: 'pem' });
  const issueContext = {
    activation_id: sourceActivation.activationId,
    target_public_key_fingerprint: installationFingerprint(targetPublicKey),
  };
  const issueChallenge = app.service.createInstallationChallenge({
    purpose: 'migration_issue', publicKey: sourcePublicKey, context: issueContext,
  });
  const grant = app.service.issueProductMigrationGrant({
    activationId: sourceActivation.activationId, refreshSecret: sourceActivation.refreshSecret,
    targetInstallationPublicKey: targetPublicKey, installationPublicKey: sourcePublicKey,
    challengeId: issueChallenge.id,
    challengeSignature: signInstallationChallenge({ challenge: issueChallenge, privateKey: sourceKeys.privateKey }),
  });
  const prepareContext = {
    grant_id: grant.grantId, build_id: build.buildId,
    domain: 'cancel-move.example.com', backend_origin: 'https://panel.example.com',
  };
  const prepareChallenge = app.service.createInstallationChallenge({
    purpose: 'migration_prepare', publicKey: targetPublicKey, context: prepareContext,
  });
  const prepared = app.service.prepareProductMigration({
    grantToken: grant.grantToken, buildId: build.buildId, packageProof: build.packageSecret,
    domain: 'cancel-move.example.com', backendUrl: 'https://panel.example.com',
    installationId: grant.targetInstallationId, installationPublicKey: targetPublicKey,
    challengeId: prepareChallenge.id,
    challengeSignature: signInstallationChallenge({ challenge: prepareChallenge, privateKey: targetKeys.privateKey }),
  });
  const rollbackContext = { grant_id: grant.grantId, phase: 'prepared' };
  const rollbackChallenge = app.service.createInstallationChallenge({
    purpose: 'migration_rollback', publicKey: targetPublicKey, context: rollbackContext,
  });
  const result = app.service.rollbackProductMigration({
    grantToken: grant.grantToken, reason: 'candidate_health_check_failed',
    installationId: grant.targetInstallationId, installationPublicKey: targetPublicKey,
    challengeId: rollbackChallenge.id,
    challengeSignature: signInstallationChallenge({ challenge: rollbackChallenge, privateKey: targetKeys.privateKey }),
  });
  assert.equal(result.sourceStatus, 'active');
  assert.equal(result.targetStatus, 'revoked');
  assert.equal(app.repository.activationById(sourceActivation.activationId).status, 'active');
  assert.equal(app.repository.activationById(prepared.activationId).status, 'revoked');
  assert.equal(app.repository.installationIdentityById(grant.targetInstallationId).status, 'revoked');
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

test('域名换绑后旧 Activation 立即撤销且无法刷新', () => {
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
    (error) => error.code === 'ACTIVATION_INACTIVE',
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

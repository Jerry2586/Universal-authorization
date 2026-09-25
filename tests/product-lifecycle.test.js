import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { bootstrap } from '../apps/license-api/src/bootstrap.js';
import { openDatabase } from '../apps/license-api/src/database.js';
import { signInstallationChallenge } from '../packages/appgog-sdk/src/installation-identity.js';
import { verifyOfflineLicenseFile } from '../packages/appgog-sdk/src/verifier.js';
import { installationIdFromPublicKey } from '../packages/core/src/installation-proof.js';

function fixture() {
  const database = openDatabase(':memory:');
  const signing = generateKeyPairSync('ed25519');
  let now = new Date('2026-09-25T00:00:00.000Z');
  const config = {
    pepper: 'product-lifecycle-test-pepper-longer-than-32-chars',
    publicBaseUrl: 'https://license.example.com',
    activationTokenTtlSeconds: 604800,
    offlineGraceSeconds: 2592000,
    buildTicketTtlSeconds: 900,
    installActivationWindowSeconds: 3600,
  };
  const app = bootstrap({ database, config, privateKey: signing.privateKey, publicKey: signing.publicKey, clock: () => new Date(now) });
  return {
    ...app, database, publicKey: signing.publicKey,
    now: () => new Date(now),
    advance(milliseconds) { now = new Date(now.getTime() + milliseconds); },
  };
}

function createBuild(app, domain = 'lifecycle.example.com') {
  const issued = app.service.issueLicense({ customerRef: `customer-${domain}`, domain });
  const authorization = app.service.authorizeBuild({ licenseKey: issued.licenseKey, version: '1.19.0', domain });
  const build = app.service.claimBuild({ buildTicket: authorization.buildTicket });
  return { issued, build, domain };
}

function activateWithServerIdentity(app, domain = 'identity.example.com') {
  const { issued, build } = createBuild(app, domain);
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
  const installationId = installationIdFromPublicKey(publicKey);
  const receipt = app.service.unlockInstall({
    installKey: build.installKey, buildId: build.buildId, packageProof: build.packageSecret,
    domain, backendUrl: 'https://panel.example.com', installationId,
  });
  const context = {
    install_receipt_id: receipt.receiptId, build_id: build.buildId,
    domain, backend_origin: 'https://panel.example.com',
  };
  const challenge = app.service.createInstallationChallenge({ purpose: 'activation', publicKey, context });
  const activation = app.service.activate({
    licenseKey: issued.licenseKey, installReceiptId: receipt.receiptId,
    installReceiptSecret: receipt.receiptSecret, buildId: build.buildId,
    packageProof: build.packageSecret, domain, backendUrl: 'https://panel.example.com',
    installationId, installationPublicKey: publicKey, challengeId: challenge.id,
    challengeSignature: signInstallationChallenge({ challenge, privateKey: keys.privateKey }),
  });
  return { issued, build, keys, publicKey, installationId, activation, domain };
}

test('首次点击开始固定 60 分钟窗口，刷新不重置，成功解锁后原子消费', () => {
  const app = fixture();
  const { build, domain } = createBuild(app);
  const installationId = 'ins_lifecycle_window_001';
  const windowToken = 'IWT_product_lifecycle_window_token_1234567890';
  const started = app.service.startInstallWindow({
    buildId: build.buildId, packageProof: build.packageSecret, domain, installationId, windowToken,
  });
  assert.equal(started.status, 'active');
  assert.equal(new Date(started.expiresAt).getTime() - app.now().getTime(), 3600000);
  const retried = app.service.startInstallWindow({
    buildId: build.buildId, packageProof: build.packageSecret, domain, installationId, windowToken,
  });
  assert.equal(retried.windowId, started.windowId);
  assert.equal(retried.expiresAt, started.expiresAt);
  const receipt = app.service.unlockInstall({
    installKey: build.installKey, buildId: build.buildId, packageProof: build.packageSecret,
    domain, backendUrl: 'https://panel.example.com', installationId,
    installWindowId: started.windowId, installWindowToken: windowToken,
  });
  assert.match(receipt.receiptId, /^irc_/);
  assert.equal(app.repository.installWindowById(started.windowId).status, 'consumed');
  app.database.close();
});

test('安装窗口到期后不能靠刷新重开，并返回安全清理指令', () => {
  const app = fixture();
  const { build, domain } = createBuild(app, 'expired.example.com');
  const installationId = 'ins_lifecycle_expired_001';
  const windowToken = 'IWT_product_lifecycle_expired_token_123456789';
  const started = app.service.startInstallWindow({
    buildId: build.buildId, packageProof: build.packageSecret, domain, installationId, windowToken,
  });
  app.advance(3600001);
  const status = app.service.expireInstallWindow({ windowId: started.windowId, windowToken });
  assert.equal(status.cleanupRequired, true);
  assert.equal(status.cleanupAction, 'deactivate_and_remove_theme');
  const retried = app.service.startInstallWindow({
    buildId: build.buildId, packageProof: build.packageSecret, domain, installationId, windowToken,
  });
  assert.equal(retried.status, 'expired');
  assert.equal(retried.expiresAt, started.expiresAt);
  assert.throws(() => app.service.unlockInstall({
    installKey: build.installKey, buildId: build.buildId, packageProof: build.packageSecret,
    domain, backendUrl: 'https://panel.example.com', installationId,
    installWindowId: started.windowId, installWindowToken: windowToken,
  }), (error) => error.code === 'INSTALL_WINDOW_CLOSED');
  app.database.close();
});

test('同机重装通过原安装私钥恢复并轮换 Refresh Secret', () => {
  const app = fixture();
  const setup = activateWithServerIdentity(app);
  const context = {
    license_id: setup.issued.license.id, build_id: setup.build.buildId,
    domain: setup.domain, backend_origin: 'https://panel.example.com',
  };
  const challenge = app.service.createInstallationChallenge({ purpose: 'recovery', publicKey: setup.publicKey, context });
  const recovered = app.service.recoverActivation({
    licenseKey: setup.issued.licenseKey, buildId: setup.build.buildId,
    packageProof: setup.build.packageSecret, domain: setup.domain,
    backendUrl: 'https://panel.example.com', installationId: setup.installationId,
    installationPublicKey: setup.publicKey, challengeId: challenge.id,
    challengeSignature: signInstallationChallenge({ challenge, privateKey: setup.keys.privateKey }),
  });
  assert.equal(recovered.activationId, setup.activation.activationId);
  assert.equal(recovered.recoveryGeneration, 1);
  assert.notEqual(recovered.refreshSecret, setup.activation.refreshSecret);
  assert.throws(() => app.service.refresh({
    activationId: recovered.activationId, refreshSecret: setup.activation.refreshSecret,
    domain: setup.domain, backendUrl: 'https://panel.example.com', installationId: setup.installationId,
  }), (error) => error.code === 'REFRESH_SECRET_INVALID');
  app.database.close();
});

test('离线授权文件绑定服务器身份、域名、Build 和套餐能力并可本地验签', () => {
  const app = fixture();
  const setup = activateWithServerIdentity(app, 'offline-file.example.com');
  const context = { activation_id: setup.activation.activationId, domain: setup.domain };
  const challenge = app.service.createInstallationChallenge({ purpose: 'offline_issue', publicKey: setup.publicKey, context });
  const issued = app.service.issueOfflineLicenseFile({
    activationId: setup.activation.activationId, refreshSecret: setup.activation.refreshSecret,
    installationId: setup.installationId, installationPublicKey: setup.publicKey,
    challengeId: challenge.id,
    challengeSignature: signInstallationChallenge({ challenge, privateKey: setup.keys.privateKey }),
  });
  app.advance(8 * 24 * 60 * 60 * 1000);
  const payload = verifyOfflineLicenseFile({
    file: { format: issued.format, activation_id: issued.activationId, activation_token: issued.activationToken },
    publicKey: app.publicKey, domain: setup.domain, backendUrl: 'https://panel.example.com',
    installationId: setup.installationId, buildId: setup.build.buildId,
    packageId: setup.build.packageId, now: app.now(),
  });
  assert.equal(payload.installation_identity_mode, 'server_key');
  assert.ok(payload.capabilities.includes('settings:write'));
  assert.throws(() => verifyOfflineLicenseFile({
    file: { format: issued.format, activation_id: issued.activationId, activation_token: issued.activationToken },
    publicKey: app.publicKey, domain: 'copied.example.com', backendUrl: 'https://panel.example.com',
    installationId: setup.installationId, now: app.now(),
  }), (error) => error.code === 'DOMAIN_MISMATCH');
  app.database.close();
});

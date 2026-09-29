import { spawnSync } from 'node:child_process';
import { packageContentClaims } from '../packages/core/src/package-content.js';
import { signCompactToken } from '../packages/core/src/signing.js';
import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
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

function expectedArtifactIdentity(app, leased) {
  return {
    issuer: app.config.publicBaseUrl,
    product: leased.build.product,
    version: leased.build.version,
    build_id: leased.build.buildId,
    package_id: leased.build.packageId,
    domain: leased.build.domain,
    watermark: leased.build.watermark,
  };
}

async function buildProtectedArtifact(app, { version = '1.17.0', customerRef = 'ORDER-INTEGRITY-1' } = {}) {
  const source = writeZip(new Map([
    ['APPGOG/config.json', Buffer.from(JSON.stringify({ name: 'APPGOG', version }))],
    ['APPGOG/index.html', Buffer.from('<!doctype html><html><head></head><body>Theme</body></html>')],
    ['APPGOG/assets/app.js', Buffer.from('console.log("original")')],
  ]));
  app.portal.publishSourceVersion({ planCodes: ['paid'], version, displayName: `APPGOG ${version}`, zipBuffer: source });
  const issued = app.service.issueLicense({ planCode: 'paid', customerRef, domain: 'demo.example.com', maxBuildsPerDay: 3 });
  const customer = app.sessions.loginCustomer(issued.licenseKey).session;
  const job = app.portal.enqueueCustomerBuild(customer, { version, domain: 'demo.example.com' });
  const workerId = `worker-${customerRef}`;
  const leased = app.portal.leaseBuild(workerId);
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
  return { issued, customer, job, leased, output, workerId };
}

test('完整成品链路：上传主题 ZIP、注入授权门、安装解锁后正式激活', async () => {
  const app = fixture();
  const source = writeZip(new Map([
    ['APPGOG/config.json', Buffer.from('{"name":"APPGOG","version":"1.17.0"}')],
    ['APPGOG/index.html', Buffer.from('<!doctype html><html><head><title>APPGOG</title></head><body><main>Theme</main></body></html>')],
    ['APPGOG/editor.html', Buffer.from('<!doctype html><html><head><title>Theme Studio</title></head><body><main>Editor</main></body></html>')],
    ['APPGOG/dashboard.blade.php', Buffer.from('<!doctype html><html><head></head><body>Dashboard</body></html>')],
    ['APPGOG/assets/app.js', Buffer.from('function calculateProtectedValue(input) { const originalLongVariableName = input + 1; console.log("APPGOG_VISIBLE_SOURCE_STRING"); return originalLongVariableName; } console.log(calculateProtectedValue(1));\n//# sourceMappingURL=app.js.map')],
    ['APPGOG/preview-panel.html', Buffer.from('<!doctype html><html><body>development preview</body></html>')],
    ['APPGOG/reports/custom.html', Buffer.from('<!doctype html><html><head></head><body>independent page</body></html>')],
    ['APPGOG/assets/fragment.html', Buffer.from('<section>not an executable entry</section>')],
    ['APPGOG/assets/app.js.map', Buffer.from('{"version":3,"sources":["src/app.js"]}')],
  ]));
  const version = app.portal.publishSourceVersion({ planCodes: ['paid'],
    version: '1.17.0', displayName: 'APPGOG 1.17.0', zipBuffer: source,
  });
  assert.equal(version.status, 'active');

  const issued = app.service.issueLicense({ planCode: 'paid', customerRef: 'ORDER-FULL-1', domain: 'demo.example.com' });
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
    packageManifestToken: leased.build.packageManifestToken,
    watermark: leased.build.watermark,
    domain: leased.build.domain,
  });
  assert.ok(app.artifactStore.read(leased.source.source_ref).equals(source), '构建后官方源 ZIP 必须逐字节保持不变');
  const artifactRef = `builds/${job.id}/APPGOG.zip`;
  app.artifactStore.put(artifactRef, result.buffer);
  app.portal.completeBuild('worker-full-test', job.id, {
    build_id: leased.build.buildId,
    artifact_ref: artifactRef,
    artifact_sha256: result.sha256,
    install_key: leased.build.installKey,
    package_proof: leased.build.packageSecret,
  });

  const output = readZip(app.artifactStore.read(artifactRef));
  assert.equal(output.has('APPGOG/preview-panel.html'), false);
  assert.match(output.get('APPGOG/reports/custom.html').toString(), /data-appgog-license-runtime/);
  assert.equal(output.get('APPGOG/assets/fragment.html').toString(), '<section>not an executable entry</section>');
  const index = output.get('APPGOG/index.html').toString('utf8');
  const editor = output.get('APPGOG/editor.html').toString('utf8');
  const dashboard = output.get('APPGOG/dashboard.blade.php').toString('utf8');
  assert.match(index, /data-appgog-license-runtime/);
  assert.match(editor, /data-appgog-license-runtime/);
  assert.match(dashboard, /data-appgog-license-runtime/);
  for (const entry of [index, editor, dashboard]) {
    assert.match(entry, /html:not\(\.__appgog_unlocked\)/);
    assert.ok(entry.indexOf("data-appgog-initial-lock") < entry.indexOf("data-appgog-license-runtime"));
  }
  const runtimeName = [...output.keys()].find((name) => /appgog-license\/p-[a-f0-9]+\/r-[a-f0-9]+\.js$/.test(name));
  assert.ok(runtimeName);
  const runtimeUrl = new URL(dashboard.match(/data-appgog-license-runtime="[^"]+" src="([^"]+)"/)[1], 'https://demo.example.com/');
  assert.equal(runtimeUrl.pathname, '/theme/' + runtimeName);
  const runtime = output.get(runtimeName).toString('utf8');
  assert.match(runtime, /APPGOG-PROTECTED:v1/);
  assert.doesNotMatch(runtime, /开始激活|packageProof|JSON\.parse\(atob\(/);
  const manifest = JSON.parse(output.get('APPGOG/appgog-license/build.json').toString('utf8'));
  assert.equal(manifest.build_id, leased.build.buildId);
  assert.equal(manifest.domain, 'demo.example.com');
  assert.equal(manifest.schema, 2);
  assert.equal(manifest.watermark, leased.build.watermark);
  assert.equal(manifest.integrity.algorithm, 'HMAC-SHA256');
  assert.equal(typeof manifest.content_signature, 'string');
  app.buildEngine.verifyArtifact({buffer: app.artifactStore.read(artifactRef), packageSecret: leased.build.packageSecret, expected: expectedArtifactIdentity(app, leased)});
  assert.ok(manifest.integrity.files.some((file) => file.path === runtimeName));
  assert.equal(manifest.protection.identity_algorithm, 'AES-256-GCM');
  assert.equal(manifest.protection.runtime_path, runtimeName);
  assert.equal(manifest.protection.generated_javascript_protection, 'obfuscator-v1');
  assert.equal(manifest.protection.javascript_protection, 'terser-obfuscator-v1');
  assert.equal(manifest.lifecycle.install_window_seconds, 3600);
  assert.equal(manifest.lifecycle.server_migration, 'new_installation_identity_and_controlled_handoff');
  assert.ok(output.has(manifest.protection.bridge_contract_path));
  const bridge = JSON.parse(output.get(manifest.protection.bridge_contract_path).toString('utf8'));
  assert.equal(bridge.schema, 'appgog-xboard-bridge-v1');
  assert.equal(bridge.operations.deactivate_and_remove_theme.browser_hook, 'APPGOGThemeBridge.deactivateAndRemoveTheme');
  assert.equal(bridge.plugin.package_path, manifest.protection.bridge_package_path);
  assert.equal(bridge.plugin.theme_name, 'APPGOG');
  assert.ok(output.has(manifest.protection.bridge_package_path));
  const bridgePackage = readZip(output.get(manifest.protection.bridge_package_path));
  assert.ok(bridgePackage.has('AppgogLicenseBridge/config.json'));
  const protectedAdminEntry = bridgePackage.get('AppgogLicenseBridge/assets/admin-entry.js').toString();
  assert.match(protectedAdminEntry, /APPGOG-PROTECTED:v1/);
  assert.doesNotMatch(protectedAdminEntry, /refreshThemes|XBOARD_ACCESS_TOKEN|appgog_xboard_admin_path/);
  assert.ok(protectedAdminEntry.split('\n').length < 10);
  assert.ok(bridgePackage.has('AppgogLicenseBridge/Plugin.php'));
  assert.ok(bridgePackage.has('AppgogLicenseBridge/Providers/PluginServiceProvider.php'));
  assert.ok(bridgePackage.has('AppgogLicenseBridge/Services/BridgeState.php'));
  assert.ok(bridgePackage.has('AppgogLicenseBridge/Controllers/BridgeController.php'));
  assert.ok(bridgePackage.has('AppgogLicenseBridge/routes/api.php'));
  const bridgeRoutes = bridgePackage.get('AppgogLicenseBridge/routes/api.php').toString('utf8');
  assert.match(bridgeRoutes, /Route::middleware\('admin'\)[\s\S]*\/register/);
  assert.match(bridgeRoutes, /Route::middleware\('admin'\)[\s\S]*\/sign-challenge/);
  assert.match(bridgeRoutes, /Route::post\('\/state\/runtime'/);
  assert.match(bridgeRoutes, /Route::post\('\/refresh'/);
  assert.match(bridgeRoutes, /Route::post\('\/deactivate-theme'/);
  const bridgeService = bridgePackage.get('AppgogLicenseBridge/Services/BridgeState.php').toString('utf8');
  assert.match(bridgeService, /runtimePackageState[\s\S]*'activation_token', 'denied'/);
  assert.doesNotMatch(bridgeService.match(/runtimePackageState[\s\S]*?\n    \}/u)?.[0] || '', /refresh_secret|install_window_token/);
  assert.match(bridgeService, /cleanup_action'\) !== 'deactivate_and_remove_theme'/);
  assert.ok(bridgeService.indexOf('$themes->switch($fallback)') < bridgeService.indexOf('$themes->delete($theme)'));
  assert.ok(output.has(manifest.protection.protected_identity_path));
  const protectedIdentity = output.get(manifest.protection.protected_identity_path).toString('utf8');
  assert.doesNotMatch(protectedIdentity, new RegExp(leased.build.buildId));
  assert.doesNotMatch(protectedIdentity, /demo\.example\.com/);
  assert.equal(output.has('APPGOG/assets/app.js.map'), false);
  const protectedSource = output.get('APPGOG/assets/app.js').toString('utf8');
  assert.match(protectedSource, new RegExp(`APPGOG-WM:${leased.build.watermark}`));
  assert.doesNotMatch(protectedSource, /sourceMappingURL/);
  assert.doesNotMatch(protectedSource, /originalLongVariableName/);
  assert.doesNotMatch(protectedSource, /APPGOG_VISIBLE_SOURCE_STRING/);

  const receipt = app.service.unlockInstall({
    installKey: leased.build.installKey,
    buildId: leased.build.buildId,
    packageProof: leased.build.packageSecret,
    domain: 'demo.example.com',
    backendUrl: 'https://panel.example.com',
    installationId: 'installation_full_build_1',
  });
  assert.equal(app.database.prepare('SELECT COUNT(*) AS count FROM activations').get().count, 0);
  const activation = app.service.activate({
    licenseKey: issued.licenseKey,
    installReceiptId: receipt.receiptId,
    installReceiptSecret: receipt.receiptSecret,
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

test('官方源包只读：拒绝把客户加密成品重新发布为源码并阻断构建期间回写', async () => {
  const app = fixture();
  const originalStore = app.buildEngine.artifactStore;
  try {
    const built = await buildProtectedArtifact(app, { customerRef: 'ORDER-PRISTINE-SOURCE' });
    const sourceRef = built.leased.source.source_ref;
    const before = originalStore.read(sourceRef);
    const after = originalStore.read(sourceRef);
    assert.ok(after.equals(before));
    assert.doesNotMatch(after.toString('latin1'), /APPGOG-(?:WM|PROTECTED):|data-appgog-license-runtime/);
    assert.throws(() => app.portal.publishSourceVersion({
      planCodes: ['paid'], version: '1.17.1', displayName: 'APPGOG 1.17.1', zipBuffer: built.output.buffer,
    }), { code: 'SOURCE_ALREADY_PROTECTED' });

    let reads = 0;
    app.buildEngine.artifactStore = {
      read(key) {
        const value = originalStore.read(key);
        reads += 1;
        return reads === 1 ? value : Buffer.concat([value, Buffer.from('unexpected-source-write')]);
      },
    };
    await assert.rejects(() => app.buildEngine.build({
      sourceRef,
      product: built.leased.build.product,
      version: built.leased.build.version,
      buildId: built.leased.build.buildId,
      packageId: built.leased.build.packageId,
      packageSecret: built.leased.build.packageSecret,
      packageManifestToken: built.leased.build.packageManifestToken,
      watermark: built.leased.build.watermark,
      domain: built.leased.build.domain,
    }), { code: 'SOURCE_INPUT_MUTATED' });
  } finally {
    app.buildEngine.artifactStore = originalStore;
    app.close();
  }
});

test('上传安全检查拒绝普通 PHP 与缺少 Xboard 配置的 ZIP', () => {
  const app = fixture();
  const phpZip = writeZip(new Map([
    ['APPGOG/config.json', Buffer.from('{}')],
    ['APPGOG/index.html', Buffer.from('<html></html>')],
    ['APPGOG/shell.php', Buffer.from('<?php echo 1;')],
  ]));
  assert.throws(
    () => app.portal.publishSourceVersion({ planCodes: ['paid'], version: 'bad-php', zipBuffer: phpZip }),
    (error) => error.code === 'SOURCE_PHP_REJECTED',
  );
  const missingConfig = writeZip(new Map([
    ['APPGOG/index.html', Buffer.from('<html></html>')],
    ['APPGOG/assets/app.js', Buffer.from('')],
  ]));
  assert.throws(
    () => app.portal.publishSourceVersion({ planCodes: ['paid'], version: 'bad-config', zipBuffer: missingConfig }),
    (error) => error.code === 'SOURCE_CONFIG_NOT_FOUND',
  );
  app.close();
});

test('授权中心拒绝修改文件并重算外层 ZIP 哈希的成品', async () => {
  const app = fixture();
  const built = await buildProtectedArtifact(app);
  const files = readZip(built.output.buffer);
  files.set('APPGOG/assets/app.js', Buffer.from('console.log("tampered")'));
  const tampered = writeZip(files);
  const artifactRef = `builds/${built.job.id}/tampered.zip`;
  app.artifactStore.put(artifactRef, tampered);
  assert.throws(
    () => app.portal.completeBuild(built.workerId, built.job.id, {
      build_id: built.leased.build.buildId,
      artifact_ref: artifactRef,
      artifact_sha256: createHash('sha256').update(tampered).digest('hex'),
      install_key: built.leased.build.installKey,
      package_proof: built.leased.build.packageSecret,
    }),
    (error) => error.code === 'PACKAGE_FILES_TAMPERED',
  );
  app.close();
});

test('制品校验拒绝篡改签名 Token 与跨包替换清单', async () => {
  const app = fixture();
  const first = await buildProtectedArtifact(app, { customerRef: 'ORDER-INTEGRITY-A' });

  const firstFiles = readZip(first.output.buffer);
  const manifestPath = 'APPGOG/appgog-license/build.json';
  const changedToken = JSON.parse(firstFiles.get(manifestPath).toString('utf8'));
  const tokenParts = changedToken.package_manifest_token.split('.');
  tokenParts[2] = `${tokenParts[2][0] === 'A' ? 'B' : 'A'}${tokenParts[2].slice(1)}`;
  changedToken.package_manifest_token = tokenParts.join('.');
  firstFiles.set(manifestPath, Buffer.from(JSON.stringify(changedToken, null, 2)));
  assert.throws(
    () => app.buildEngine.verifyArtifact({
      buffer: writeZip(firstFiles),
      packageSecret: first.leased.build.packageSecret,
      expected: expectedArtifactIdentity(app, first.leased),
    }),
    (error) => ['TOKEN_SIGNATURE_INVALID', 'TOKEN_INVALID'].includes(error.code),
  );

  const firstRef = 'builds/' + first.job.id + '/APPGOG.zip';
  app.artifactStore.put(firstRef, first.output.buffer);
  app.portal.completeBuild(first.workerId, first.job.id, {
    build_id: first.leased.build.buildId, artifact_ref: firstRef,
    artifact_sha256: first.output.sha256, install_key: first.leased.build.installKey,
    package_proof: first.leased.build.packageSecret,
  });
  const customer = first.customer;
  app.portal.voidCustomerBuild(customer, first.job.id);
  const secondJob = app.portal.enqueueCustomerBuild(customer, { version: '1.17.0', domain: 'demo.example.com' });
  const secondLease = app.portal.leaseBuild('worker-integrity-b');
  const secondOutput = await app.buildEngine.build({
    sourceRef: secondLease.source.source_ref,
    product: secondLease.build.product,
    version: secondLease.build.version,
    buildId: secondLease.build.buildId,
    packageId: secondLease.build.packageId,
    packageSecret: secondLease.build.packageSecret,
    packageManifestToken: secondLease.build.packageManifestToken,
    watermark: secondLease.build.watermark,
    domain: secondLease.build.domain,
  });
  assert.equal(secondLease.job.id, secondJob.id);
  const crossed = readZip(first.output.buffer);
  crossed.set(manifestPath, readZip(secondOutput.buffer).get(manifestPath));
  assert.throws(
    () => app.buildEngine.verifyArtifact({
      buffer: writeZip(crossed),
      packageSecret: first.leased.build.packageSecret,
      expected: expectedArtifactIdentity(app, first.leased),
    }),
    (error) => error.code === 'BUILD_RESULT_MISMATCH',
  );
  app.close();
});

test('制品校验拒绝篡改每包 AES-GCM 加密身份载荷', async () => {
  const app = fixture();
  const built = await buildProtectedArtifact(app, { customerRef: 'ORDER-PROTECTION-TAMPER' });
  const files = readZip(built.output.buffer);
  const manifest = JSON.parse(files.get('APPGOG/appgog-license/build.json').toString('utf8'));
  const protectedPath = manifest.protection.protected_identity_path;
  const envelope = JSON.parse(files.get(protectedPath).toString('utf8'));
  envelope.c = `${envelope.c[0] === 'A' ? 'B' : 'A'}${envelope.c.slice(1)}`;
  const tampered = Buffer.from(JSON.stringify(envelope), 'utf8');
  files.set(protectedPath, tampered);
  manifest.protection.protected_identity_sha256 = createHash('sha256').update(tampered).digest('hex');
  files.set('APPGOG/appgog-license/build.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  assert.throws(
    () => app.buildEngine.verifyArtifact({
      buffer: writeZip(files),
      packageSecret: built.leased.build.packageSecret,
      expected: expectedArtifactIdentity(app, built.leased),
    }),
    (error) => error.code === 'PACKAGE_PROTECTION_INVALID',
  );
  app.close();
});


test('未使用构建复用、作废权限与审计回滚', async (t) => {
  const app = fixture(); t.after(() => app.close());
  const built = await buildProtectedArtifact(app, { customerRef: 'ORDER-LIFECYCLE' });
  const repeat = () => app.portal.enqueueCustomerBuild(built.customer, { version: '1.17.0', domain: 'demo.example.com' });
  assert.equal(repeat().id, built.job.id);
  assert.equal(repeat().reused, true);
  assert.throws(() => app.portal.voidCustomerBuild(built.customer, built.job.id), { code: 'BUILD_CANNOT_VOID' });
  const ref = 'builds/' + built.job.id + '/APPGOG.zip';
  app.artifactStore.put(ref, built.output.buffer);
  app.portal.completeBuild(built.workerId, built.job.id, {
    build_id: built.leased.build.buildId, artifact_ref: ref,
    artifact_sha256: built.output.sha256, install_key: built.leased.build.installKey,
    package_proof: built.leased.build.packageSecret,
  });
  assert.equal(repeat().id, built.job.id);
  assert.equal(app.portal.buildDetails(built.customer, built.job.id).can_void, true);
  assert.equal(app.portal.customerOverview(built.customer).builds.find(job => job.id === built.job.id).can_void, true);
  const other = app.service.issueLicense({ planCode: 'paid', customerRef: 'OTHER', domain: 'other.example.com' });
  const otherSession = app.sessions.loginCustomer(other.licenseKey).session;
  assert.throws(() => app.portal.voidCustomerBuild(otherSession, built.job.id), { code: 'BUILD_JOB_NOT_FOUND' });
  app.database.exec("CREATE TEMP TRIGGER deny_void_audit BEFORE INSERT ON audit_events WHEN NEW.action = 'build_job.voided' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
  assert.throws(() => app.portal.voidCustomerBuild(built.customer, built.job.id), /audit unavailable/);
  assert.equal(app.repository.buildJobById(built.job.id).status, 'succeeded');
  assert.equal(app.repository.buildById(built.leased.build.buildId).status, 'ready');
  assert.equal(app.repository.installKeyByBuildId(built.leased.build.buildId).status, 'available');
  assert.equal(app.repository.totalBuildCount(built.customer.actor_id), 1);
  assert.equal(app.repository.buildJobById(built.job.id).quota_refunded_at, null);
  app.database.exec('DROP TRIGGER deny_void_audit');
  assert.equal(app.portal.voidCustomerBuild(built.customer, built.job.id).status, 'cancelled');
  assert.throws(() => app.artifactStore.read(ref), { code: 'ENOENT' });
  assert.equal(app.repository.totalBuildCount(built.customer.actor_id), 0);
  assert.equal(app.repository.recentBuildCount(built.customer.actor_id, '2026-09-21T08:00:00.000Z'), 0);
  assert.ok(app.repository.buildJobById(built.job.id).quota_refunded_at);
  assert.equal(app.portal.voidCustomerBuild(built.customer, built.job.id).status, 'cancelled');
  assert.equal(app.portal.buildDetails(built.customer, built.job.id).install_key, null);
  assert.equal(app.portal.customerOverview(built.customer).builds.find(job => job.id === built.job.id).can_void, false);
  assert.throws(() => app.portal.artifactForDownload(built.customer, built.job.id), { code: 'ARTIFACT_NOT_READY', message: '此构建已作废，安装包不可下载，请重新构建' });
  assert.notEqual(app.repository.installKeyByBuildId(built.leased.build.buildId).status, 'available');
  assert.notEqual(repeat().id, built.job.id);
  assert.equal(app.database.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='build_job.voided'").get().n, 1);
});


test('过期 Worker 租约不会永久复用坏任务，旧 Worker 不能交付', async (t) => {
  const app = fixture(); t.after(() => app.close());
  const built = await buildProtectedArtifact(app, { customerRef: 'ORDER-EXPIRED-WORKER' });
  app.database.prepare('UPDATE build_jobs SET lease_expires_at = ? WHERE id = ?')
    .run('2026-09-22T07:59:59.000Z', built.job.id);
  const next = app.portal.enqueueCustomerBuild(built.customer, { version: '1.17.0', domain: 'demo.example.com' });
  assert.notEqual(next.id, built.job.id);
  assert.equal(app.repository.buildJobById(built.job.id).error_code, 'BUILD_LEASE_EXPIRED');
  assert.equal(app.repository.buildById(built.leased.build.buildId).status, 'revoked');
  assert.equal(app.repository.totalBuildCount(built.customer.actor_id), 0);
  assert.throws(() => app.portal.updateBuildProgress(built.workerId, built.job.id, { progress: 82, message: 'late progress' }), { code: 'BUILD_LEASE_INVALID' });
  assert.equal(app.portal.leaseBuild('replacement-worker').job.id, next.id);
});

test('不同构建意图和基础版本不能静默复用旧任务', async (t) => {
  const app = fixture(); t.after(() => app.close());
  const built = await buildProtectedArtifact(app, { customerRef: 'ORDER-INTENTS' });
  const update = app.portal.enqueueCustomerBuild(built.customer, { version: '1.17.0', domain: 'demo.example.com', intent: 'update', base_version: '1.16.0' });
  assert.notEqual(update.id, built.job.id);
  const differentBase = app.portal.enqueueCustomerBuild(built.customer, { version: '1.17.0', domain: 'demo.example.com', intent: 'update', base_version: '1.15.0' });
  assert.notEqual(differentBase.id, update.id);
  assert.equal(app.portal.enqueueCustomerBuild(built.customer, { version: '1.17.0', domain: 'demo.example.com', intent: 'update', base_version: '1.16.0' }).id, update.id);
});

test('作废文件清理失败保留重试记录且不能继续下载', async (t) => {
  const app = fixture(); t.after(() => app.close());
  const built = await buildProtectedArtifact(app, { customerRef: 'ORDER-CLEANUP' });
  const ref = 'builds/' + built.job.id + '/APPGOG.zip';
  app.artifactStore.put(ref, built.output.buffer);
  app.portal.completeBuild(built.workerId, built.job.id, {
    build_id: built.leased.build.buildId, artifact_ref: ref, artifact_sha256: built.output.sha256,
    install_key: built.leased.build.installKey, package_proof: built.leased.build.packageSecret,
  });
  const remove = app.artifactStore.remove.bind(app.artifactStore);
  app.artifactStore.remove = () => { throw new Error('disk temporarily busy'); };
  assert.equal(app.portal.voidCustomerBuild(built.customer, built.job.id).status, 'cancelled');
  assert.equal(app.repository.buildJobById(built.job.id).artifact_ref, ref);
  assert.throws(() => app.portal.artifactForDownload(built.customer, built.job.id), { code: 'ARTIFACT_NOT_READY', message: '此构建已作废，安装包不可下载，请重新构建' });
  app.artifactStore.remove = remove;
  app.portal.leaseBuild('cleanup-worker');
  assert.equal(app.repository.buildJobById(built.job.id).artifact_ref, null);
  assert.throws(() => app.artifactStore.read(ref), { code: 'ENOENT' });
  assert.equal(app.repository.totalBuildCount(built.customer.actor_id), 0);
});

// Xboard extracts the config directory and serves Blade at /; ZIP paths are not browser URLs.
test('Blade runtime URL follows Xboard public theme name at root and nested routes', async () => {
  const app = fixture();
  try {
    for (const wrapper of ['', 'download-wrapper/']) {
      const sourceBuffer = writeZip(new Map([
        [wrapper + 'config.json', Buffer.from(JSON.stringify({ name: 'CustomTheme', version: '1.0.0' }))],
        [wrapper + 'dashboard.blade.php', Buffer.from('<html><head><base href="/account/"></head><body>Theme</body></html>')],
        [wrapper + 'editor.html', Buffer.from('<html><head></head><body>Editor</body></html>')],
      ]));
      const result = await app.buildEngine.build({ sourceBuffer, product: 'appgog', version: '1.0.0',
        buildId: 'bld-runtime-path', packageId: 'pkg-runtime-path', packageSecret: 'fixture-only-package-proof-for-runtime-path',
        packageManifestToken: 'fixture-token', watermark: 'fixture-path', domain: 'demo.example.com' });
      const files = readZip(result.buffer);
      const manifest = JSON.parse(files.get(wrapper + 'appgog-license/build.json'));
      const expected = '/theme/CustomTheme/' + manifest.protection.runtime_path.slice(wrapper.length);
      const blade = files.get(wrapper + 'dashboard.blade.php').toString();
      const src = blade.match(/data-appgog-license-runtime="[^"]+" src="([^"]+)"/)[1];
      for (const base of ['https://demo.example.com/', 'https://demo.example.com/account/', 'https://demo.example.com/nested/route']) {
        assert.equal(new URL(src, base).pathname, expected);
      }
      const editor = files.get(wrapper + 'editor.html').toString();
      const editorSrc = editor.match(/data-appgog-license-runtime="[^"]+" src="([^"]+)"/)[1];
      assert.equal(new URL(editorSrc, 'https://demo.example.com/theme/CustomTheme/editor.html').pathname, expected);
      assert.ok(files.has(wrapper + expected.slice('/theme/CustomTheme/'.length)));
    }
  } finally { app.close(); }
});

test('打包历史翻页覆盖超过30条、同一时间无重复、搜索与会话隔离', (t) => {
  const app = fixture(); t.after(() => app.close());
  const first = app.service.issueLicense({ planCode: 'paid', customerRef: 'HISTORY-A', domain: 'demo.example.com' });
  const second = app.service.issueLicense({ planCode: 'paid', customerRef: 'HISTORY-B', domain: 'other.example.com' });
  const customer = app.sessions.loginCustomer(first.licenseKey).session;
  const other = app.sessions.loginCustomer(second.licenseKey).session;
  for (let i = 0; i < 47; i++) app.repository.createBuildJob({ id: `history-${String(i).padStart(3, '0')}`, licenseId: customer.actor_id,
    version: i === 5 ? '2.5.0' : '1.0.0', domain: 'demo.example.com', sourceKind: 'upload', now: '2026-09-22T08:00:00.000Z' });
  app.repository.createBuildJob({ id: 'other-job', licenseId: other.actor_id, version: '1.0.0', domain: 'other.example.com', sourceKind: 'upload', now: '2026-09-22T08:00:00.000Z' });
  let cursor = '', ids = [];
  do {
    const page = app.portal.customerBuildHistory(customer, { cursor, limit: 20 });
    ids.push(...page.items.map(job => job.id)); cursor = page.next_cursor;
    assert.equal(page.has_more, Boolean(cursor));
    assert.ok(page.items.every(job => job.domain === 'demo.example.com'));
  } while (cursor);
  assert.equal(ids.length, 47); assert.equal(new Set(ids).size, 47);
  assert.equal(app.portal.customerBuildHistory(customer, { query: '2.5.0' }).items.length, 1);
  assert.equal(app.portal.customerBuildHistory(customer, { query: 'other' }).items.length, 0);
  const foreignCursor = app.portal.customerBuildHistory(customer, { limit: 1 }).next_cursor;
  assert.ok(app.portal.customerBuildHistory(other, { cursor: foreignCursor }).items.every(job => job.domain === 'other.example.com'));
  assert.throws(() => app.portal.customerBuildHistory(customer, { limit: 101 }), { code: 'HISTORY_PAGE_INVALID' });
  assert.throws(() => app.portal.customerBuildHistory(customer, { cursor: 'wrong' }), { code: 'HISTORY_CURSOR_INVALID' });
  const queued = app.portal.voidCustomerBuild(customer, ids[0]);
  assert.equal(queued.quota_refunded_at, null); assert.equal(app.repository.totalBuildCount(customer.actor_id), 0);
  assert.equal(app.portal.voidCustomerBuild(customer, ids[0]).quota_refunded_at, null);
});


test('中心内容签名拒绝包持有者重算HMAC、降级与替换公钥；未签名草稿不能交付', async () => {
  const app = fixture();
  try {
    const built = await buildProtectedArtifact(app, { customerRef: 'CONTENT-SEAL' });
    const expected = expectedArtifactIdentity(app, built.leased);
    const check = buffer => app.buildEngine.verifyArtifact({buffer, packageSecret: built.leased.build.packageSecret, expected});
    assert.throws(() => check(built.output.buffer), { code: 'PACKAGE_CONTENT_SIGNATURE_MISSING' });
    const artifactRef = 'builds/' + built.job.id + '/sealed.zip';
    app.artifactStore.put(artifactRef, built.output.buffer);
    app.portal.completeBuild(built.workerId, built.job.id, {
      build_id: built.leased.build.buildId, artifact_ref: artifactRef,
      artifact_sha256: built.output.sha256, install_key: built.leased.build.installKey,
      package_proof: built.leased.build.packageSecret,
    });
    const sealed = app.artifactStore.read(artifactRef);
    check(sealed);
    const detail = app.portal.buildDetails(built.customer, built.job.id);
    assert.equal(detail.artifact_sha256, createHash('sha256').update(sealed).digest('hex'));
    assert.notEqual(detail.artifact_sha256, built.output.sha256);
    const manifestPath = 'APPGOG/appgog-license/build.json';
    for (const attack of ['file+hmac','strip-seal','replace-key','metadata','remove-requirement']) {
      const files=readZip(sealed), manifest=JSON.parse(files.get(manifestPath));
      if (attack === 'file+hmac') {
        files.set('APPGOG/assets/app.js', Buffer.from('console.log("changed after signing")'));
        manifest.integrity.files=[...files].filter(([p])=>p!==manifestPath).sort(([a],[b])=>a.localeCompare(b)).map(([path,b])=>({path,bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')}));
        const {schema,product,version,build_id,package_id,domain,watermark,protection}=manifest;
        manifest.integrity.digest=createHmac('sha256',built.leased.build.packageSecret).update(JSON.stringify({schema,product,version,build_id,package_id,domain,watermark,protection,files:manifest.integrity.files})).digest('hex');
      }
      if (attack === 'strip-seal') delete manifest.content_signature;
      if (attack === 'replace-key') manifest.verification_keys.package=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'});
      if (attack === 'metadata') manifest.license_server='https://substituted.invalid';
      if (attack === 'remove-requirement') {const parts=manifest.package_manifest_token.split('.');const payload=JSON.parse(Buffer.from(parts[1],'base64url'));delete payload.content_signature_required;parts[1]=Buffer.from(JSON.stringify(payload)).toString('base64url');manifest.package_manifest_token=parts.join('.');}
      files.set(manifestPath,Buffer.from(JSON.stringify(manifest)));
      assert.throws(()=>check(writeZip(files)), e=>['PACKAGE_CONTENT_SIGNATURE_INVALID','PACKAGE_CONTENT_SIGNATURE_MISSING','TOKEN_SIGNATURE_INVALID'].includes(e.code),attack);
    }
  } finally {app.close();}
});


test('真实成品中心签名被PHP桥验签，篡改与公钥替换拒绝且旧登记保留', async () => {
  const app=fixture();
  try {
    const built=await buildProtectedArtifact(app,{customerRef:'PHP-SEAL'});
    const ref='builds/'+built.job.id+'/php.zip';app.artifactStore.put(ref,built.output.buffer);
    app.portal.completeBuild(built.workerId,built.job.id,{build_id:built.leased.build.buildId,artifact_ref:ref,artifact_sha256:built.output.sha256,install_key:built.leased.build.installKey,package_proof:built.leased.build.packageSecret});
    const files=readZip(app.artifactStore.read(ref));
    const themeRoot=join(app.root,'installed','APPGOG'),privateRoot=join(app.root,'private');
    const manifestPath=join(themeRoot,'appgog-license/build.json');
    for(const [p,b] of files){const path=join(app.root,'installed',p);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,b);}
    const publishedRoot=join(privateRoot,'public','theme','APPGOG');
    for(const [p,b] of files){const path=join(publishedRoot,p.slice('APPGOG/'.length));mkdirSync(dirname(path),{recursive:true});writeFileSync(path,b);}
    const trustedKeyPath=join(app.root,'trusted-public.pem');writeFileSync(trustedKeyPath,app.publicKey.export({type:'spki',format:'pem'}));
    const check=()=>{const result=spawnSync(process.env.APPGOG_TEST_PHP||'php',[resolve('tests/fixtures/bridge-content-signature.php'),resolve('apps/build-worker/xboard-bridge/AppgogLicenseBridge/Host/Guard.php'),themeRoot,privateRoot,trustedKeyPath],{encoding:'utf8',timeout:30000});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout.replace(/^\uFEFF/,''));};
    assert.deepEqual(check(),{content_valid:true,enrolled:true});
    writeFileSync(join(publishedRoot,'assets/app.js'),'public copy only modified');
    assert.deepEqual(check(),{content_valid:false,enrolled:true});
    writeFileSync(join(publishedRoot,'assets/app.js'),files.get('APPGOG/assets/app.js'));
    assert.deepEqual(check(),{content_valid:true,enrolled:true});
    writeFileSync(join(publishedRoot,'unexpected.js'),'injected script');
    assert.deepEqual(check(),{content_valid:false,enrolled:true});
    rmSync(join(publishedRoot,'unexpected.js'));
    writeFileSync(join(themeRoot,'assets/app.js'),'modified after signing');
    assert.deepEqual(check(),{content_valid:false,enrolled:false});
    writeFileSync(join(themeRoot,'assets/app.js'),files.get('APPGOG/assets/app.js'));
    const manifest=JSON.parse(files.get('APPGOG/appgog-license/build.json'));
    const missing=structuredClone(manifest);delete missing.content_signature;writeFileSync(manifestPath,JSON.stringify(missing));
    assert.deepEqual(check(),{content_valid:false,enrolled:false});
    const other=generateKeyPairSync('ed25519');const replacement=structuredClone(manifest);
    replacement.verification_keys={activation:other.publicKey.export({type:'spki',format:'pem'}),package:other.publicKey.export({type:'spki',format:'pem'})};
    const claims=JSON.parse(Buffer.from(manifest.package_manifest_token.split('.')[1],'base64url'));
    replacement.package_manifest_token=signCompactToken(claims,other.privateKey);
    replacement.content_signature=signCompactToken(packageContentClaims(replacement,claims.iss),other.privateKey);
    writeFileSync(manifestPath,JSON.stringify(replacement));
    assert.deepEqual(check(),{content_valid:false,enrolled:false});
    writeFileSync(manifestPath,files.get('APPGOG/appgog-license/build.json'));
    assert.deepEqual(check(),{content_valid:true,enrolled:true});
  }finally{app.close();}
});

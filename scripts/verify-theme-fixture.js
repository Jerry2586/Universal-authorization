import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHttpHandler } from '../apps/license-api/src/http.js';
import { join, resolve } from 'node:path';
import { bootstrap } from '../apps/license-api/src/bootstrap.js';
import { openDatabase } from '../apps/license-api/src/database.js';
import { readZip, writeZip } from '../packages/core/src/zip.js';
import { verifyActivation } from '../packages/appgog-sdk/src/verifier.js';
import { installationIdFromPublicKey } from '../packages/core/src/installation-proof.js';
import { signInstallationChallenge } from '../packages/appgog-sdk/src/installation-identity.js';

// Isolated regression: never connects to production or writes customer credentials.
const input = process.argv[2];
if (!input) throw new Error('Usage: node scripts/verify-theme-fixture.js <real-theme.zip>');
const source = readFileSync(resolve(input));
const sourceFiles = readZip(source);
const configPath = [...sourceFiles.keys()].find(path => /(^|\/)config\.json$/.test(path));
assert.ok(configPath, 'Theme config is required');
const descriptor = JSON.parse(sourceFiles.get(configPath));
const version = descriptor.version;
assert.ok(version, 'Theme version is required');
const root = mkdtempSync(join(tmpdir(), 'appgog-real-theme-'));
const database = openDatabase(':memory:');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
const secret = () => randomBytes(32).toString('hex');
const config = {
  pepper: secret(), sessionSecret: secret(), deliveryEncryptionKey: secret(),
  adminToken: secret(), adminUsername: 'regression', adminPassword: secret(), workerToken: secret(),
  publicBaseUrl: 'https://fixture.invalid', activationTokenTtlSeconds: 3600,
  buildTicketTtlSeconds: 900, webSessionTtlSeconds: 28800, maxSourceUploadBytes: 128 * 1024 * 1024,
  artifactRoot: join(root, 'artifacts'), uploadRoot: join(root, 'uploads'),
};
try {
  const app = bootstrap({ database, config, privateKey, publicKey: publicKeyPem });
  app.portal.publishSourceVersion({ version, zipBuffer: source });
  const license = app.service.issueLicense({ customerRef: 'REAL-THEME-REGRESSION', domain: 'fixture.example.com' });
  const customer = app.sessions.loginCustomer(license.licenseKey).session;
  const job = app.portal.enqueueCustomerBuild(customer, { version, domain: 'fixture.example.com' });
  // Run the CPU-heavy protector in a separate process, as the production Worker does.
  // This exercises real HTTP progress/completion after a long build, including stale sockets.
  let leased;
  const portal = { ...app.portal, leaseBuild(...args) { leased = app.portal.leaseBuild(...args); return leased; } };
  const center = createServer(createHttpHandler({ ...app, portal, config, publicKey: publicKeyPem }));
  center.listen(0, '127.0.0.1');
  await once(center, 'listening');
  try {
    const worker = spawn(process.execPath, ['--input-type=module', '-e',       "import {runWorkerOnce} from './apps/build-worker/src/server.js'; import {LocalArtifactStore} from './packages/adapters/src/local-artifact-store.js'; let input=''; for await (const chunk of process.stdin) input+=chunk; const c=JSON.parse(input); await runWorkerOnce({...c,artifactStore:new LocalArtifactStore(c.artifactRoot)});"], { cwd: resolve(import.meta.dirname, '..'), stdio: ['pipe', 'ignore', 'pipe'] });
    let diagnostic = '';
    worker.stderr.on('data', chunk => { diagnostic += chunk; });
    worker.stdin.end(JSON.stringify({ baseUrl: 'http://127.0.0.1:' + center.address().port,
      token: config.workerToken, workerId: 'fixture-worker', artifactRoot: config.artifactRoot,
      publicKey: publicKeyPem, publicBaseUrl: config.publicBaseUrl }));
    const [exitCode] = await once(worker, 'exit');
    assert.equal(exitCode, 0, diagnostic);
  } finally {
    center.closeAllConnections();
    await new Promise(resolve => center.close(resolve));
  }
  const detail = app.portal.buildDetails(customer, job.id);
  assert.equal(detail.status, 'succeeded');
  const buffer = app.artifactStore.read('builds/' + job.id + '/APPGOG-' + version + '-' + leased.build.buildId + '.zip');
  const output = { buffer, sha256: createHash('sha256').update(buffer).digest('hex') };
  const files = readZip(output.buffer);
  const themeRoot = configPath.slice(0, -'config.json'.length);
  for (const entry of ['index.html', 'editor.html', 'dashboard.blade.php']) {
    assert.ok(files.has(themeRoot + entry), 'Missing real theme entry: ' + entry);
    assert.match(files.get(themeRoot + entry).toString(), /data-appgog-license-runtime/);
  }
  assert.ok(files.has(themeRoot + 'appgog-license/appgog-license-bridge.zip'));
  for (const [path, content] of files) {
    assert.ok(!path.endsWith('.map'), 'Unexpected source map: ' + path);
    if (/\.js$/.test(path) && sourceFiles.has(path)) {
      assert.match(content.toString(), /APPGOG-WM:/);
      assert.notDeepEqual(content, sourceFiles.get(path), 'Business JS unchanged: ' + path);
    }
  }
  const manifest = JSON.parse(files.get(themeRoot + 'appgog-license/build.json'));
  const expectedRuntimePath = '/theme/' + descriptor.name + '/' + manifest.protection.runtime_path.slice(themeRoot.length);
  for (const entry of ['index.html', 'editor.html', 'dashboard.blade.php']) {
    const html = files.get(themeRoot + entry).toString();
    const src = html.match(/data-appgog-license-runtime="[^"]+" src="([^"]+)"/)[1];
    const page = entry.endsWith('.blade.php') ? '/' : '/theme/' + descriptor.name + '/' + entry;
    assert.equal(new URL(src, 'https://fixture.example.com' + page).pathname, expectedRuntimePath, entry + ' runtime URL must resolve to the published asset');
  }
  const expected = { issuer: config.publicBaseUrl, product: leased.build.product, version,
    build_id: leased.build.buildId, package_id: leased.build.packageId,
    domain: leased.build.domain, watermark: leased.build.watermark };
  const tampered = new Map(files);
  tampered.set(themeRoot + 'editor.html', Buffer.from('<html>tampered</html>'));
  assert.throws(() => app.buildEngine.verifyArtifact({ buffer: writeZip(tampered), packageSecret: leased.build.packageSecret, expected }));
  const identity = generateKeyPairSync('ed25519');
  const installationPublicKey = identity.publicKey.export({ type: 'spki', format: 'pem' });
  const installationId = installationIdFromPublicKey(installationPublicKey);
  const proofFor = (purpose, context) => {
    const challenge = app.service.createInstallationChallenge({ purpose, publicKey: installationPublicKey, context });
    return { installationPublicKey, challengeId: challenge.id,
      challengeSignature: signInstallationChallenge({ challenge, privateKey: identity.privateKey }) };
  };
  const windowToken = 'IWT_' + secret();
  const started = app.service.startInstallWindow({ buildId: leased.build.buildId, packageProof: leased.build.packageSecret,
    domain: leased.build.domain, installationId, windowToken,
    ...proofFor('install_window', { build_id: leased.build.buildId, domain: leased.build.domain, install_window_token: windowToken }) });
  const context = { buildId: leased.build.buildId, packageProof: leased.build.packageSecret,
    domain: leased.build.domain, backendUrl: 'https://fixture.example.com', installationId,
    installWindowId: started.windowId, installWindowToken: windowToken };
  assert.throws(() => app.service.unlockInstall({ ...context, installKey: 'INS-WRONG' }));
  const receipt = app.service.unlockInstall({ ...context, installKey: leased.build.installKey });
  assert.throws(() => app.service.unlockInstall({ ...context, installKey: leased.build.installKey, installationId: 'another_installation' }));
  const activated = app.service.activate({ ...context, ...proofFor('activation', { install_receipt_id: receipt.receiptId, build_id: context.buildId, domain: context.domain, backend_origin: context.backendUrl }), licenseKey: license.licenseKey,
    installReceiptId: receipt.receiptId, installReceiptSecret: receipt.receiptSecret });
  const claims = verifyActivation({ token: activated.token, publicKey, domain: context.domain,
    backendUrl: context.backendUrl, installationId: context.installationId, now: new Date() });
  assert.equal(claims.package_id, leased.build.packageId);
  console.log(JSON.stringify({ result: 'passed', source: resolve(input), version,
    source_sha256: createHash('sha256').update(source).digest('hex'), artifact_sha256: output.sha256,
    files: files.size, entrypoints: 3, protection: manifest.protection.javascript_protection,
    checks: ['real_http_worker_process', 'real_zip_build', 'three_gated_entries', 'published_runtime_urls', 'bridge_bundle', 'business_js_protection',
      'no_source_maps', 'tamper_rejected', 'wrong_key_rejected', 'install_key_single_use', 'signed_install_window', 'fixed_key_activation'] }, null, 2));
} finally {
  database.close();
  rmSync(root, { recursive: true, force: true });
}

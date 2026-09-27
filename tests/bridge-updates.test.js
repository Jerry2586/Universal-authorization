import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeUpdates } from '../apps/license-api/src/modules/operations/bridge-updates.js';
import { createBridgeDistribution } from '../packages/adapters/src/bridge-distribution.js';
import { signBridgeDelivery, verifyBridgeDelivery } from '../packages/core/src/bridge-delivery.js';
import { bridgeFromSignedRelease, createBridgeReleaseSource } from '../packages/adapters/src/bridge-release-source.js';
import { writeZip, readZip } from '../packages/core/src/zip.js';

test('only signed platform ZIP with matching hash/version yields bridge plugin', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const version = '1.2.43', prefix = `APPGOG-Packaging-Licensing-System-${version}/apps/build-worker/xboard-bridge/AppgogLicenseBridge/`;
  const zip = writeZip({ [prefix + 'config.json']: JSON.stringify({ code: 'appgog_license_bridge', version: '1.1.3' }), [prefix + 'Plugin.php']: '<?php' });
  const manifest = Buffer.from(JSON.stringify({ schema: 2, product: 'appgog', version, zip_name: `APPGOG-Packaging-Licensing-System-${version}.zip`, zip_sha256: createHash('sha256').update(zip).digest('hex') }));
  const signature = sign(null, manifest, privateKey);
  const artifact = bridgeFromSignedRelease(manifest, signature, zip, { publicKey, version });
  assert.equal(artifact.version, '1.1.3'); assert.ok(readZip(artifact.buffer).has('AppgogLicenseBridge/Plugin.php'));
  assert.throws(() => bridgeFromSignedRelease(Buffer.from('tamper'), signature, zip, { publicKey, version }), /签名/);
  assert.throws(() => bridgeFromSignedRelease(manifest, signature, Buffer.from('tamper'), { publicKey, version }), /摘要/);
  assert.throws(() => bridgeFromSignedRelease(manifest, signature, zip, { publicKey, version: '1.2.44' }), /版本/);
});
test('release source rejects untrusted redirect destinations', async () => {
  const source = createBridgeReleaseSource({ transport: async () => ({ status: 302, headers: { location: 'https://example.com/archive' }, body: Buffer.alloc(0) }) });
  await assert.rejects(source.latest(), /不受信任/);
});

test('release metadata uses GitHub JSON media type and changed assets are reverified', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const version = '1.2.43', prefix = `APPGOG-Packaging-Licensing-System-${version}/apps/build-worker/xboard-bridge/AppgogLicenseBridge/`;
  const zip = writeZip({ [prefix + 'config.json']: JSON.stringify({ code: 'appgog_license_bridge', version: '1.1.3' }), [prefix + 'Plugin.php']: '<?php' });
  const manifest = Buffer.from(JSON.stringify({ schema: 2, product: 'appgog', version, zip_name: `APPGOG-Packaging-Licensing-System-${version}.zip`, zip_sha256: createHash('sha256').update(zip).digest('hex') }));
  const signature = sign(null, manifest, privateKey);
  let epoch = 1, downloads = 0;
  const source = createBridgeReleaseSource({ publicKey, transport: async (url, options) => {
    let body;
    if (url.endsWith('/latest')) {
      assert.equal(options.headers.accept, 'application/vnd.github+json');
      body = Buffer.from(JSON.stringify({ id: 1, tag_name: 'v' + version, assets: ['release-manifest.json','release-manifest.json.sig',`APPGOG-Packaging-Licensing-System-${version}.zip`].map((name, id) => ({ id: id + epoch * 10, name, browser_download_url: 'https://github.com/releases/' + name })) }));
    } else { downloads++; body = url.endsWith('.sig') ? signature : url.endsWith('.json') ? manifest : zip; }
    return { status: 200, headers: {}, body };
  } });
  assert.equal((await source.latest()).version, '1.1.3'); assert.equal(downloads, 3);
  await source.latest(); assert.equal(downloads, 3);
  epoch++; await source.latest(); assert.equal(downloads, 6);
});

const keys = generateKeyPairSync('ed25519');
function signedArtifact(version = '1.1.4', release = '1.2.45') {
  const prefix = `APPGOG-Packaging-Licensing-System-${release}/apps/build-worker/xboard-bridge/AppgogLicenseBridge/`;
  const zip = writeZip({ [prefix + 'config.json']: JSON.stringify({ code: 'appgog_license_bridge', version }), [prefix + 'Plugin.php']: '<?php // test' });
  const manifest = Buffer.from(JSON.stringify({ schema: 2, product: 'appgog', version: release,
    zip_name: `APPGOG-Packaging-Licensing-System-${release}.zip`, zip_sha256: createHash('sha256').update(zip).digest('hex') }));
  return bridgeFromSignedRelease(manifest, sign(null, manifest, keys.privateKey), zip, { publicKey: keys.publicKey, version: release });
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'appgog-bridge-'));
  let baseline = signedArtifact('1.1.3', '1.2.44'), saved = null, now = Date.now(), inside = false, fail = false, latest = signedArtifact();
  const distributionOptions = { root, publicKey: keys.publicKey, bundled: () => baseline };
  const distribution = createBridgeDistribution(distributionOptions);
  const repairedReleases = [];
  const releases = { latest: async () => { if (fail) throw Error('private-secret'); return latest; },
    byVersion: async version => { repairedReleases.push(version); if (fail) throw Error('private-secret'); return version === '1.2.44' ? signedArtifact('1.1.3', version) : signedArtifact('1.1.4', version); } };
  const options = { distribution, releases, packagePrivateKey: keys.privateKey, issuer: 'https://license.example',
    repository: { setting: () => saved, setSetting: (_, value) => { assert.ok(inside); saved = value; }, audit: () => assert.ok(inside) },
    atomic: fn => { inside = true; try { return fn(); } finally { inside = false; } }, clock: () => new Date(now) };
  return { api: createBridgeUpdates(options), distribution, distributionOptions, options, root, repairedReleases,
    advance: ms => now += ms, fail: () => fail = true, setLatest: value => latest = value, seed: value => saved = JSON.stringify(value),
    upgradeBaseline: () => baseline = signedArtifact('1.1.5', '1.2.46') };
}
const session = { actor_id: 'admin' };
async function run(api, action) {
  api.enqueue(session, action);
  for (let i = 0; i < 100 && api.status().busy; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.status().busy, false);
  return api.status();
}
test('component maintenance needs no connection; update and exact-version repair affect build snapshots', async () => {
  const f = fixture();
  assert.equal(f.api.status().current_version, '1.1.3');
  assert.equal(f.api.status().repairable, true);
  assert.throws(() => f.api.enqueue(session, 'install-version'), /先检查/);
  assert.equal((await run(f.api, 'check-update')).installable, true);
  assert.equal((await run(f.api, 'install-version')).current_version, '1.1.4');
  assert.equal(f.api.snapshot().descriptor.version, '1.1.4');
  assert.equal((await run(f.api, 'repair-current')).state, 'succeeded');
  assert.deepEqual(f.repairedReleases, ['1.2.45']);
  const restarted = createBridgeDistribution(f.distributionOptions);
  assert.equal(restarted.snapshot().version, '1.1.4');
  const delivery = f.api.delivery(f.api.snapshot(), { buildId: 'build-test' });
  assert.equal(verifyBridgeDelivery(delivery, 'build-test', 'https://license.example', keys.publicKey).version, '1.1.4');
});
test('expired checks, failures, changed release and downgrade cannot replace selected component', async () => {
  const f = fixture(); await run(f.api, 'check-update'); f.advance(600001);
  assert.equal(f.api.status().latest_version, null);
  assert.throws(() => f.api.enqueue(session, 'install-version'), /先检查/);
  await run(f.api, 'check-update'); f.setLatest(signedArtifact('1.1.5'));
  assert.equal((await run(f.api, 'install-version')).state, 'failed');
  assert.equal(f.distribution.snapshot().version, '1.1.3');
  f.setLatest(signedArtifact('1.1.2'));
  assert.equal((await run(f.api, 'check-update')).installable, false);
  f.fail(); const state = await run(f.api, 'check-update');
  assert.equal(state.latest_version, null); assert.equal(state.state, 'failed');
  assert.doesNotMatch(JSON.stringify(state), /private-secret/);
});
test('tampered persisted component blocks builds; repair re-downloads same release, failed write keeps old selection', async () => {
  const f = fixture(); await run(f.api, 'check-update'); await run(f.api, 'install-version');
  const pointer = JSON.parse(readFileSync(join(f.root, 'bridge-distribution/active.json')));
  writeFileSync(join(f.root, 'bridge-distribution', pointer.id, 'platform.zip'), 'tamper');
  assert.throws(() => f.api.snapshot(), /校验失败/);
  assert.equal(f.api.status().current_version, null);
  assert.equal((await run(f.api, 'repair-current')).current_version, '1.1.4');
  const bad = signedArtifact('1.1.5'); bad.evidence.signature = Buffer.alloc(64);
  assert.throws(() => f.distribution.install(bad), /签名/);
  assert.equal(f.distribution.snapshot().version, '1.1.4');
  f.upgradeBaseline();
  assert.equal(createBridgeDistribution(f.distributionOptions).snapshot().version, '1.1.5');
});
test('bundled repair is allowed; concurrent tasks reject, restart does not replay interrupted operation', async () => {
  const f = fixture();
  assert.equal((await run(f.api, 'repair-current')).current_version, '1.1.3');
  assert.deepEqual(f.repairedReleases, ['1.2.44']);
  f.api.enqueue(session, 'check-update');
  assert.throws(() => f.api.enqueue(session, 'check-update'), /重复/);
  await new Promise(resolve => setImmediate(resolve));
  f.seed({ operation_id: 'old', state: 'running', action: 'install-version' });
  const restarted = createBridgeUpdates(f.options);
  assert.equal(restarted.status().state, 'failed'); assert.match(restarted.status().message, /重启/);
});
test('worker accepts only package-key signed component bound to build, issuer and lifetime', () => {
  const artifact = signedArtifact(), now = Date.now();
  const delivery = signBridgeDelivery(artifact, 'build', 'https://license.example', keys.privateKey, now);
  assert.equal(verifyBridgeDelivery(delivery, 'build', 'https://license.example', keys.publicKey, now).version, '1.1.4');
  assert.throws(() => verifyBridgeDelivery(delivery, 'other', 'https://license.example', keys.publicKey, now), /不匹配/);
  assert.throws(() => verifyBridgeDelivery(delivery, 'build', 'https://other.example', keys.publicKey, now), /不匹配/);
  assert.throws(() => verifyBridgeDelivery(delivery, 'build', 'https://license.example', keys.publicKey, now + 3600001), /不匹配/);
  assert.throws(() => verifyBridgeDelivery({ ...delivery, buffer: Buffer.from('tamper').toString('base64') }, 'build', 'https://license.example', keys.publicKey, now), /不匹配/);
  assert.throws(() => verifyBridgeDelivery(delivery, 'build', 'https://license.example', generateKeyPairSync('ed25519').publicKey, now), /签名/);
});

test('corrupt active index can be repaired from its verified recovery metadata without changing bridge version', async () => {
  const f = fixture(); await run(f.api, 'check-update'); await run(f.api, 'install-version');
  writeFileSync(join(f.root, 'bridge-distribution/active.json'), 'corrupt-index');
  assert.equal(f.api.status().current_version, null);
  assert.equal(f.api.status().repairable, true);
  assert.equal((await run(f.api, 'repair-current')).current_version, '1.1.4');
  assert.deepEqual(f.repairedReleases, ['1.2.45']);
  assert.throws(()=>f.distribution.install(signedArtifact('1.1.4','1.2.44'),{repair:true}),/降级/);
});

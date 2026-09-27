import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { createBridgeUpdates } from '../apps/license-api/src/modules/operations/bridge-updates.js';
import { createXboardBridgeClient, normalizeBridgeTarget, publicAddress, publicHttps } from '../packages/adapters/src/xboard-bridge-client.js';
import { bridgeFromSignedRelease, createBridgeReleaseSource } from '../packages/adapters/src/bridge-release-source.js';
import { writeZip, readZip } from '../packages/core/src/zip.js';

const session = { id: 'admin-session', actor_id: 'admin', expires_at: '2026-09-29T00:00:00Z' };
function fixture() {
  let now = Date.parse('2026-09-28T00:00:00Z'), saved = null, version = '1.1.0', identity = 'original';
  let failRelease = false, failInspect = false, uploads = 0, inside = false;
  const repository = { setting: () => saved, setSetting: (_, value) => { assert.ok(inside); saved = value; }, audit: event => { assert.ok(inside); assert.ok(event.action); } };
  const client = { connect: async input => ({ origin: input.origin, token: 'private-token' }),
    inspect: async () => { if (failInspect) throw Error('private response'); return { version, identity }; },
    upload: async (_c, _b, v) => { uploads++; version = v; }, repair: async () => ({ ok: true }) };
  const releases = { latest: async () => { if (failRelease) throw Error('secret'); return { version: '1.1.3', release_version: '1.2.43', buffer: Buffer.from('zip') }; } };
  const options = { client, releases, repository, atomic: fn => { inside = true; try { return fn(); } finally { inside = false; } }, clock: () => new Date(now), delay: async () => {}, attempts: 2 };
  const api = createBridgeUpdates(options);
  return { api, client, releases, options, connect: () => api.connect(session, { origin: 'https://example.com' }),
    advance: ms => now += ms, failRelease: () => failRelease = true, failInspect: () => failInspect = true,
    setIdentity: value => identity = value, setVersion: value => version = value, uploads: () => uploads,
    saved: () => saved, seed: value => saved = JSON.stringify(value) };
}
async function run(api, action) {
  api.enqueue(session, action);
  for (let i = 0; i < 100 && api.status(session).busy; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.status(session).busy, false);
  return api.status(session);
}

test('bridge update checks, installs once and preserves running identity; credentials never persist', async () => {
  const f = fixture(); await f.connect();
  assert.equal(f.api.status(session).current_version, '1.1.0');
  assert.throws(() => f.api.enqueue(session, 'install-version'), /先检查/);
  assert.equal((await run(f.api, 'check-update')).installable, true);
  const state = await run(f.api, 'install-version');
  assert.equal(state.state, 'succeeded'); assert.equal(state.current_version, '1.1.3'); assert.equal(f.uploads(), 1);
  assert.doesNotMatch(f.saved(), /private-token/);
  assert.equal((await run(f.api, 'repair-current')).state, 'succeeded');
  assert.equal((await run(f.api, 'check-update')).installable, false);
});
test('bridge freshness, session isolation, expiry, source behind, failed checks never reuse latest', async () => {
  const f = fixture(); await f.connect();
  assert.throws(() => f.api.enqueue({ ...session, id: 'other' }, 'check-update'), /过期/);
  await run(f.api, 'check-update'); f.advance(600001);
  assert.equal(f.api.status(session).latest_version, null);
  assert.throws(() => f.api.enqueue(session, 'install-version'), /先检查/);
  f.setVersion('1.1.4'); assert.equal((await run(f.api, 'check-update')).installable, false);
  f.failRelease(); const state = await run(f.api, 'check-update');
  assert.equal(state.state, 'failed'); assert.equal(state.latest_version, null); assert.doesNotMatch(JSON.stringify(state), /secret/);
  f.advance(600000); assert.equal(f.api.status(session).connected, false);
});
test('bridge tasks are single-flight, interrupted tasks are not replayed, mismatched identity is rejected', async () => {
  const f = fixture(); await f.connect();
  f.api.enqueue(session, 'check-update');
  assert.throws(() => f.api.enqueue(session, 'check-update'), /重复/);
  assert.throws(() => f.api.disconnect(session), /不能断开/);
  await new Promise(resolve => setImmediate(resolve));
  f.client.upload = async () => { f.setVersion('1.1.3'); f.setIdentity('replacement'); };
  assert.equal((await run(f.api, 'install-version')).state, 'failed');
  assert.equal(f.api.status(session).current_version, null);
  f.seed({ state: 'running', origin: 'https://example.com', operation_id: 'interrupted' });
  const restarted = createBridgeUpdates(f.options);
  assert.match(restarted.status(session).message, /重启/); assert.equal(restarted.status(session).state, 'failed');
});
test('uncertain upload and health timeouts fail visibly without retrying writes', async () => {
  const f = fixture(); await f.connect(); await run(f.api, 'check-update');
  let count = 0; f.client.upload = async () => { count++; throw Error('lost response'); };
  assert.equal((await run(f.api, 'install-version')).state, 'failed'); assert.equal(count, 1);
  await run(f.api, 'check-update'); f.client.upload = async () => { count++; };
  assert.equal((await run(f.api, 'install-version')).state, 'failed'); assert.equal(count, 2);
});
test('failed target replacement clears previous connection; stale source change stops upload', async () => {
  const f = fixture(); await f.connect(); await run(f.api, 'check-update');
  f.releases.latest = async () => ({ version: '1.1.4' });
  assert.equal((await run(f.api, 'install-version')).state, 'failed'); assert.equal(f.uploads(), 0);
  f.client.connect = async () => { throw Error('offline'); };
  await assert.rejects(f.connect()); assert.equal(f.api.status(session).connected, false);
});
test('target adapter refuses private, mapped IPv6 and mixed DNS answers before credentials leave', async () => {
  for (const address of ['127.0.0.1','10.0.0.1','169.254.169.254','100.64.0.2','192.168.1.1','::1','::ffff:8.8.8.8','2002:0808:0808::1','2001:db8::1']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('8.8.8.8'), true); assert.equal(publicAddress('2606:4700:4700::1111'), true);
  for (const target of ['http://example.com','https://user:pass@example.com','https://example.com/admin','https://localhost','https://example.com:8443']) assert.throws(() => normalizeBridgeTarget(target));
  await assert.rejects(publicHttps('https://example.com', { resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] }), /内网/);
});
test('Xboard adapter verifies plugin enablement and actual process, rejects redirects and failed JSON', async () => {
  let enabled = true, stale = false, rejected = false, redirect = false;
  const calls = [];
  const client = createXboardBridgeClient({ transport: async (url, options) => {
    calls.push({ url, options });
    const body = url.endsWith('/login') ? { data: { auth_data: 'secret' } }
      : url.endsWith('/getPlugins') ? { data: [{ code: 'appgog_license_bridge', version: '1.1.3', is_enabled: enabled }] }
      : url.endsWith('/health') ? { ok: true, code: 'appgog_license_bridge', version: stale ? '1.1.0' : '1.1.3', identity: { installation_id: 'original' } }
      : rejected ? { status: 'fail' } : { data: true };
    return { status: redirect ? 302 : 200, headers: {}, body: Buffer.from(JSON.stringify(body)) };
  } });
  const c = await client.connect({ origin: 'https://example.com', admin_path: 'secure', email: 'admin@example.com', password: 'password' });
  assert.equal((await client.inspect(c)).version, '1.1.3');
  await client.upload(c, Buffer.from('zip'), '1.1.3'); assert.match(calls.at(-1).options.headers['content-type'], /multipart/);
  enabled = false; await assert.rejects(client.inspect(c), /停用/); enabled = true;
  stale = true; await assert.rejects(client.inspect(c), /进程不一致/); stale = false;
  rejected = true; await assert.rejects(client.upload(c, Buffer.from('zip'), '1.1.3'), /拒绝/);
  redirect = true; const before = calls.length; await assert.rejects(client.inspect(c), /302/); assert.equal(calls.length, before + 1);
});
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

test('logout explicitly forgets the remote credential connection', async () => {
  const f = fixture(); await f.connect(); f.api.forget(session);
  assert.equal(f.api.status(session).connected, false);
  assert.throws(() => f.api.enqueue(session, 'check-update'), /过期/);
});

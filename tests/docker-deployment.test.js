import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { initialize, secretNames } from '../scripts/docker/initialize.js';
import { validateEntries } from '../scripts/docker/restore.js';
import { roleHealthUrls, healthUrls } from '../scripts/docker/health.js';
import { standbyServer } from '../scripts/docker/unpaired.js';
import { PACKAGE_VERSION } from '../packages/core/src/version.js';

const env = { AUTH_DOMAIN: 'sq.appgog.test', BUILD_DOMAIN: 'db.appgog.test' };
function fixture(t) { const root = mkdtempSync(join(tmpdir(), 'appgog-docker-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
function composeSource(name) {
  return readFileSync(join(resolve(import.meta.dirname, '..'), name), 'utf8');
}
function composeServices(source) {
  const services = source.split('services:')[1].split('\nvolumes:')[0];
  return [...services.matchAll(/^  ([\w-]+):$/gm)].map(match => match[1]);
}
test('Docker initializes once, retains identities on update, and isolates role credentials', t => {
  const root = fixture(t);
  const first = initialize({ root, env });
  assert.match(first.identity.adminPassword, /^\d{6}$/);
  const keyPath = join(root, 'var/keys/ed25519-private.pem');
  const key = readFileSync(keyPath, 'utf8');
  writeFileSync(join(root, 'var/data/appgog.sqlite'), 'existing-database');
  const second = initialize({ root, env: { ...env, AUTH_DOMAIN: 'new.appgog.test' } });
  assert.deepEqual(first.identity, second.identity);
  assert.equal(readFileSync(keyPath, 'utf8'), key);
  assert.equal(readFileSync(join(root, 'var/data/appgog.sqlite'), 'utf8'), 'existing-database');
  const worker = readFileSync(join(root, 'runtime/worker/runtime.env'), 'utf8');
  const build = readFileSync(join(root, 'runtime/build/runtime.env'), 'utf8');
  for (const name of secretNames.filter(name => name !== 'WORKER_TOKEN')) assert.ok(!worker.includes(first.identity.secrets[name]));
  for (const name of secretNames.filter(name => name !== 'INTERNAL_SERVICE_TOKEN')) assert.ok(!build.includes(first.identity.secrets[name]));
  assert.match(readFileSync(join(root, 'runtime/license/runtime.env'), 'utf8'), /PUBLIC_BASE_URL=https:\/\/new.appgog.test/);
});
test('Docker refuses to start a valid database whose control plane is fenced', t => {
  const root = fixture(t);
  initialize({ root, env });
  const database = new DatabaseSync(join(root, 'var/data/appgog.sqlite'));
  database.exec(`
    CREATE TABLE control_plane_identity (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    INSERT INTO control_plane_identity (id, status) VALUES ('primary', 'fenced');
  `);
  database.close();
  assert.throws(() => initialize({ root, env }), /数据库控制中心身份已被 Fenced/);
});
test('Docker refuses to regenerate lost signing keys or overwrite legacy secrets', t => {
  const root = fixture(t);
  initialize({ root, env });
  rmSync(join(root, 'var/keys/ed25519-private.pem'));
  assert.throws(() => initialize({ root, env }), /密钥丢失/);
  rmSync(join(root, 'runtime/license/identity.json'));
  assert.throws(() => initialize({ root, env }), /旧数据/);
});
test('Docker imports the original legacy credentials without key rotation', t => {
  const root = fixture(t);
  const first = initialize({ root, env });
  rmSync(join(root, 'runtime/license/identity.json'));
  const imported = initialize({ root, env: { ...env, ...first.identity.secrets, ADMIN_USERNAME: first.identity.adminUsername, ADMIN_PASSWORD: first.identity.adminPassword } });
  assert.deepEqual(imported.identity.secrets, first.identity.secrets);
  assert.equal(imported.identity.keyFingerprint, first.identity.keyFingerprint);
});
test('Docker safely adds the license encryption key to identities created before v1.2.0', t => {
  const root = fixture(t);
  const first = initialize({ root, env });
  const identityPath = join(root, 'runtime/license/identity.json');
  const legacyIdentity = JSON.parse(readFileSync(identityPath, 'utf8'));
  delete legacyIdentity.secrets.LICENSE_ENCRYPTION_KEY;
  writeFileSync(identityPath, JSON.stringify(legacyIdentity));
  const database = new DatabaseSync(join(root, 'var/data/appgog.sqlite'));
  database.exec('CREATE TABLE licenses (key_encrypted TEXT)');
  database.close();
  const upgraded = initialize({ root, env });
  assert.match(upgraded.identity.secrets.LICENSE_ENCRYPTION_KEY, /^[A-Za-z0-9_-]{32,}$/);
  for (const name of secretNames.filter(name => name !== 'LICENSE_ENCRYPTION_KEY')) {
    assert.equal(upgraded.identity.secrets[name], first.identity.secrets[name]);
  }
  assert.ok(upgraded.identity.migrations.licenseEncryptionKey);
});
test('Docker refuses to replace a missing license encryption key after encrypted keys exist', t => {
  const root = fixture(t);
  initialize({ root, env });
  const identityPath = join(root, 'runtime/license/identity.json');
  const legacyIdentity = JSON.parse(readFileSync(identityPath, 'utf8'));
  delete legacyIdentity.secrets.LICENSE_ENCRYPTION_KEY;
  writeFileSync(identityPath, JSON.stringify(legacyIdentity));
  const database = new DatabaseSync(join(root, 'var/data/appgog.sqlite'));
  database.exec("CREATE TABLE licenses (key_encrypted TEXT); INSERT INTO licenses VALUES ('encrypted-envelope')");
  database.close();
  assert.throws(() => initialize({ root, env }), /禁止自动换钥/);
  assert.equal(JSON.parse(readFileSync(identityPath, 'utf8')).secrets.LICENSE_ENCRYPTION_KEY, undefined);
});
test('Docker refuses invalid domains and placeholder secrets', t => {
  const root = fixture(t);
  assert.throws(() => initialize({ root, env: { ...env, AUTH_DOMAIN: 'http://auth.test' } }), /HTTPS/);
  assert.throws(() => initialize({ root, env: { ...env, BUILD_DOMAIN: env.AUTH_DOMAIN } }), /不同域名/);
  assert.throws(() => initialize({ root, env: { ...env, WORKER_TOKEN: 'replace-with-at-least-32-random-characters' } }), /生产凭证/);
});
test('Restore rejects traversal, foreign paths, links and incomplete backups', () => {
  const files = ['runtime/license/identity.json', 'var/keys/ed25519-private.pem', 'var/keys/ed25519-public.pem', 'var/data/appgog.sqlite'];
  validateEntries(files, files.map(() => '-rw-------'));
  for (const bad of ['../escape', '/etc/passwd', 'var/data/../../escape', 'var/data/link/../../../escape']) assert.throws(() => validateEntries([...files, bad], []));
  assert.throws(() => validateEntries(files, ['lrwxrwxrwx']));
  assert.throws(() => validateEntries(files.slice(1), []));
});

test('Split build backups restore without license secrets and reject cross-role archives', () => {
  const buildFiles = ['runtime/build/runtime.env', 'runtime/worker/runtime.env', 'var/artifacts/build.zip'];
  validateEntries(buildFiles, buildFiles.map(() => '-rw-------'), 'build');
  assert.throws(() => validateEntries(buildFiles, [], 'license'), /备份缺少/);
  assert.throws(() => validateEntries(['runtime/build/runtime.env'], [], 'build'), /备份缺少/);
  assert.throws(() => validateEntries([...buildFiles, 'var/keys/ed25519-private.pem'], [], 'build'), /混入授权中心/);
  assert.throws(() => validateEntries([...buildFiles, 'runtime/license/identity.json'], [], 'build'), /混入授权中心/);
  assert.throws(() => validateEntries(buildFiles, [], 'unexpected'), /无效部署角色/);
});

test('Docker preserves custom policy settings and rejects invalid replacements', t => {
  const root = fixture(t);
  initialize({ root, env: { ...env, OFFLINE_GRACE_SECONDS: '86400', INSTALL_ACTIVATION_WINDOW_SECONDS: '1800', MAX_SOURCE_UPLOAD_BYTES: '1048576' } });
  initialize({ root, env });
  const runtime = readFileSync(join(root, 'runtime/license/runtime.env'), 'utf8');
  assert.match(runtime, /OFFLINE_GRACE_SECONDS=86400/);
  assert.match(runtime, /INSTALL_ACTIVATION_WINDOW_SECONDS=1800/);
  assert.match(runtime, /MAX_SOURCE_UPLOAD_BYTES=1048576/);
  assert.throws(() => initialize({ root, env: { ...env, OFFLINE_GRACE_SECONDS: '-1' } }), /正整数/);
  assert.throws(() => initialize({ root, env: { ...env, INSTALL_ACTIVATION_WINDOW_SECONDS: '0' } }), /正整数/);
});

test('role-specific Compose files keep one hardened service and least-privilege persistent mounts', () => {
  const start = readFileSync(join(resolve(import.meta.dirname, '..'), 'scripts/docker/start.js'), 'utf8');
  const compose = composeSource('compose.yaml');
  const licenseCompose = composeSource('compose.license.yaml');
  const buildCompose = composeSource('compose.build.yaml');
  const caddy = readFileSync(join(resolve(import.meta.dirname, '..'), 'Caddyfile'), 'utf8');
  for (const source of [compose, licenseCompose, buildCompose]) {
    assert.deepEqual(composeServices(source), ['appgog']);
    assert.match(source, /appgog-caddy-data:\/app\/runtime\/caddy-data/);
    assert.match(source, /read_only: true/);
    assert.match(source, /cap_drop: \[ALL\]/);
    assert.match(source, /no-new-privileges:true/);
    assert.match(source, /scripts\/docker\/health.js/);
  }
  assert.match(licenseCompose, /APPGOG_DEPLOYMENT_ROLE: license/);
  assert.match(licenseCompose, /appgog-db:\/app\/var\/data/);
  assert.match(licenseCompose, /appgog-keys:\/app\/var\/keys/);
  assert.match(licenseCompose, /appgog-license-config:\/app\/runtime\/license/);
  assert.doesNotMatch(licenseCompose, /appgog-build-config:\/app\/runtime\/build/);
  assert.doesNotMatch(licenseCompose, /appgog-worker-config:\/app\/runtime\/worker/);
  assert.match(buildCompose, /APPGOG_DEPLOYMENT_ROLE: build/);
  assert.doesNotMatch(buildCompose, /appgog-db:\/app\/var\/data/);
  assert.doesNotMatch(buildCompose, /appgog-keys:\/app\/var\/keys/);
  assert.doesNotMatch(buildCompose, /appgog-uploads:\/app\/var\/uploads/);
  assert.doesNotMatch(buildCompose, /appgog-license-config:\/app\/runtime\/license/);
  for (const name of ['LICENSE_SERVICE_ENABLED', 'CUSTOMER_LOGIN_ENABLED', 'BUILD_CENTER_ENABLED', 'NEW_BUILDS_ENABLED', 'WORKER_ENABLED']) {
    assert.match(buildCompose, new RegExp(`${name}: false`));
  }
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:8787/);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:8788/);
  assert.match(start, /APPGOG_STARTUP_TIMEOUT_MS/);
  assert.match(start, /启动失败/);
});

test('Cloud security identities are separate and initialization fails closed on missing reader material', t => {
  const root = fixture(t);
  const security = join(root, 'runtime/security');
  mkdirSync(security, { recursive: true });
  const cloud = { ...env, SECURITY_CLOUD_URL: 'https://security.appgog.test:9443',
    SECURITY_CLOUD_LICENSE_TOKEN: 'l'.repeat(40), SECURITY_CLOUD_BUILD_TOKEN: 'b'.repeat(40),
    SECURITY_CLOUD_READER_TOKEN: 'r'.repeat(40) };
  for (const name of ['ca.crt', 'license.crt', 'license.key', 'build.crt', 'build.key']) writeFileSync(join(security, name), name);
  assert.throws(() => initialize({ root, env: cloud }), /reader 身份凭据缺失/);
  writeFileSync(join(security, 'reader.crt'), 'reader.crt');
  writeFileSync(join(security, 'reader.key'), 'reader.key');
  initialize({ root, env: cloud });
  const runtime = readFileSync(join(root, 'runtime/license/runtime.env'), 'utf8');
  assert.match(runtime, /SECURITY_CLOUD_CLIENT_CERT=.*reader\.crt/);
  assert.match(runtime, /SECURITY_CLOUD_CLIENT_KEY=.*reader\.key/);
  assert.ok(!runtime.includes(cloud.SECURITY_CLOUD_LICENSE_TOKEN));
  assert.ok(!runtime.includes(cloud.SECURITY_CLOUD_BUILD_TOKEN));
  assert.ok(runtime.includes(cloud.SECURITY_CLOUD_READER_TOKEN));
});

test('split build cloud linkage requires build and reader identities but never a license identity', t => {
  const root = fixture(t);
  const security = join(root, 'runtime/security');
  mkdirSync(security, { recursive: true });
  const cloud = { ...env, APPGOG_DEPLOYMENT_ROLE: 'build', APPGOG_BUSINESS_PAIRED: 'true',
    BUILD_CENTER_NODE_TOKEN: 'n'.repeat(48), WORKER_NODE_TOKEN: 'w'.repeat(48),
    SECURITY_CLOUD_URL: 'https://security.appgog.test:9443',
    SECURITY_CLOUD_BUILD_TOKEN: 'b'.repeat(40), SECURITY_CLOUD_READER_TOKEN: 'r'.repeat(40) };
  for (const name of ['ca.crt', 'build.crt', 'build.key']) writeFileSync(join(security, name), name);
  assert.throws(() => initialize({ root, env: cloud }), /reader 身份凭据缺失/);
  writeFileSync(join(security, 'reader.crt'), 'reader.crt');
  writeFileSync(join(security, 'reader.key'), 'reader.key');
  assert.doesNotThrow(() => initialize({ root, env: cloud }));
  assert.equal(existsSync(join(security, 'license.crt')), false);
  assert.equal(existsSync(join(security, 'license.key')), false);
});

test('split build node keeps authorization identity and signing keys off the build host', t => {
  const root = fixture(t);
  const buildToken = 'b'.repeat(48);
  const workerToken = 'w'.repeat(48);
  const buildEnv = { ...env, APPGOG_DEPLOYMENT_ROLE: 'build', BUILD_CENTER_NODE_TOKEN: buildToken,
    WORKER_NODE_TOKEN: workerToken };
  const first = initialize({ root, env: buildEnv });
  assert.equal(first.identity, null);
  initialize({ root, env: buildEnv });
  assert.equal(readFileSync(join(root, 'runtime/build/runtime.env'), 'utf8').includes(buildToken), true);
  assert.equal(readFileSync(join(root, 'runtime/worker/runtime.env'), 'utf8').includes(workerToken), true);
  for (const path of ['runtime/license/identity.json', 'runtime/license/runtime.env',
    'var/keys/ed25519-private.pem', 'var/data/appgog.sqlite']) {
    assert.equal(existsSync(join(root, path)), false, `unexpected authorization secret: ${path}`);
  }
  assert.throws(() => initialize({ root, env: { ...buildEnv, WORKER_NODE_TOKEN: buildToken } }), /独立/);
  assert.throws(() => initialize({ root, env: { ...buildEnv, BUILD_CENTER_NODE_TOKEN: 'short' } }), /有效/);
  writeFileSync(join(root, 'runtime/license/identity.json'), '{}');
  assert.throws(() => initialize({ root, env: buildEnv }), /拒绝转换/);
});

test('license-only node starts without issuing local build worker secrets', t => {
  const root = fixture(t);
  const initialized = initialize({ root, env: { ...env, APPGOG_DEPLOYMENT_ROLE: 'license' } });
  assert.ok(initialized.identity);
  assert.equal(existsSync(join(root, 'runtime/build/runtime.env')), false);
  assert.equal(existsSync(join(root, 'runtime/worker/runtime.env')), false);
});
test('standalone build installation is safe before pairing and survives pairing without license secrets', t => {
  const root = fixture(t);
  const waiting = { ...env, APPGOG_DEPLOYMENT_ROLE: 'build', APPGOG_BUSINESS_PAIRED: 'false' };
  const standby = initialize({ root, env: waiting });
  assert.equal(standby.unpaired, true);
  assert.equal(existsSync(join(root, 'runtime/build/runtime.env')), false);
  assert.equal(existsSync(join(root, 'runtime/worker/runtime.env')), false);
  assert.equal(existsSync(join(root, 'runtime/license/identity.json')), false);
  assert.deepEqual(roleHealthUrls('build'), [healthUrls.build, healthUrls.caddy]);
  assert.deepEqual(roleHealthUrls('license'), [healthUrls.license, healthUrls.caddy]);
  assert.deepEqual(roleHealthUrls('all'), [healthUrls.license, healthUrls.build, healthUrls.caddy]);
  assert.throws(() => initialize({ root, env: { ...waiting, WORKER_NODE_TOKEN: 'w'.repeat(48) } }), /待配对节点/);
  const paired = { ...waiting, APPGOG_BUSINESS_PAIRED: 'true', BUILD_CENTER_NODE_TOKEN: 'b'.repeat(48), WORKER_NODE_TOKEN: 'w'.repeat(48) };
  assert.equal(initialize({ root, env: paired }).unpaired, undefined);
  assert.equal(readFileSync(join(root, 'runtime/build/runtime.env'), 'utf8').includes(paired.BUILD_CENTER_NODE_TOKEN), true);
  assert.equal(readFileSync(join(root, 'runtime/worker/runtime.env'), 'utf8').includes(paired.WORKER_NODE_TOKEN), true);
  assert.equal(existsSync(join(root, 'var/data/appgog.sqlite')), false);
  initialize({ root, env: paired });
  assert.equal(readFileSync(join(root, 'runtime/build/runtime.env'), 'utf8').includes(paired.BUILD_CENTER_NODE_TOKEN), true);
});

test('unpaired build center exposes readiness but rejects all business routes', async t => {
  const server = standbyServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const health = await fetch(origin + '/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, paired: false, service: 'appgog-build-standby', version: PACKAGE_VERSION });
  for (const path of ['/build', '/web/customer/login', '/api/v1/builds/authorize', '/admin']) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'BUSINESS_PAIR_REQUIRED');
  }
});

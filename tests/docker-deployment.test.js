import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { initialize, secretNames } from '../scripts/docker/initialize.js';
import { validateEntries } from '../scripts/docker/restore.js';

const env = { AUTH_DOMAIN: 'sq.appgog.test', BUILD_DOMAIN: 'db.appgog.test' };
function fixture(t) { const root = mkdtempSync(join(tmpdir(), 'appgog-docker-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
test('Docker initializes once, retains identities on update, and isolates role credentials', t => {
  const root = fixture(t);
  const first = initialize({ root, env });
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

test('Docker preserves custom policy settings and rejects invalid replacements', t => {
  const root = fixture(t);
  initialize({ root, env: { ...env, OFFLINE_GRACE_SECONDS: '86400', MAX_SOURCE_UPLOAD_BYTES: '1048576' } });
  initialize({ root, env });
  const runtime = readFileSync(join(root, 'runtime/license/runtime.env'), 'utf8');
  assert.match(runtime, /OFFLINE_GRACE_SECONDS=86400/);
  assert.match(runtime, /MAX_SOURCE_UPLOAD_BYTES=1048576/);
  assert.throws(() => initialize({ root, env: { ...env, OFFLINE_GRACE_SECONDS: '-1' } }), /正整数/);
});

test('Compose includes managed HTTPS ingress and persists certificate state', () => {
  const compose = readFileSync(join(resolve(import.meta.dirname, '..'), 'compose.yaml'), 'utf8');
  const caddy = readFileSync(join(resolve(import.meta.dirname, '..'), 'Caddyfile'), 'utf8');
  assert.match(compose, /caddy:2\.10-alpine/);
  assert.match(compose, /"80:80"/);
  assert.match(compose, /"443:443"/);
  assert.match(compose, /appgog-caddy-data:\/data/);
  assert.match(caddy, /\{\$AUTH_DOMAIN\}/);
  assert.match(caddy, /reverse_proxy license-center:8787/);
  assert.match(caddy, /\{\$BUILD_DOMAIN\}/);
  assert.match(caddy, /reverse_proxy build-center:8788/);
  assert.match(compose, /build-worker:[\s\S]*read_only: true/);
  assert.match(compose, /build-worker:[\s\S]*cap_drop:[\s\S]*- ALL/);
  assert.match(compose, /build-worker:[\s\S]*no-new-privileges:true/);
  assert.match(compose, /build-worker:[\s\S]*pids_limit: 256/);
  assert.match(compose, /build-worker:[\s\S]*mem_limit: 1g/);
  assert.match(compose, /build-worker:[\s\S]*cpus: "1\.5"/);
});

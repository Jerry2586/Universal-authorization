// Isolated CI role backup fixture; never logs credentials or business contents.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { initialize } from './initialize.js';
const role = process.env.APPGOG_DEPLOYMENT_ROLE;
assert.ok(['license', 'build'].includes(role));
const action = process.argv[2];
assert.ok(['create', 'verify'].includes(action));
const marker = '/app/var/artifacts/role-backup-fixture.json';
const payload = '/app/var/artifacts/role-backup-payload.bin';
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const files = role === 'license'
  ? ['/app/runtime/license/identity.json', '/app/var/keys/ed25519-private.pem', '/app/var/keys/ed25519-public.pem']
  : ['/app/runtime/build/runtime.env', '/app/runtime/worker/runtime.env'];
if (action === 'create') {
  if (role === 'build') {
    // Exercise persistent paired configuration without connecting a fixture to a production upstream.
    initialize({ env: { ...process.env, APPGOG_BUSINESS_PAIRED: 'true',
      BUILD_CENTER_NODE_TOKEN: randomBytes(48).toString('base64url'), WORKER_NODE_TOKEN: randomBytes(48).toString('base64url') } });
  } else {
    const identity = JSON.parse(readFileSync(files[0], 'utf8'));
    const response = await fetch('http://127.0.0.1:8787/web/admin/login', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: identity.adminUsername, password: identity.adminPassword }) });
    assert.equal(response.status, 200);
    const login = await response.json();
    const issued = await fetch('http://127.0.0.1:8787/web/admin/licenses', { method: 'POST',
      headers: { 'content-type': 'application/json', cookie: response.headers.getSetCookie()[0].split(';')[0], 'x-csrf-token': login.csrf_token },
      body: JSON.stringify({ plan_code: 'paid', customer_ref: 'ROLE-BACKUP-CI', domain: 'role-backup.test' }) });
    assert.ok(issued.ok, 'role fixture license creation failed'); await issued.arrayBuffer();
  }
  writeFileSync(payload, randomBytes(1024 * 1024 + 17), { mode: 0o600 });
  writeFileSync(marker, JSON.stringify({ role, files: files.map(sha), payload: sha(payload) }), { mode: 0o600 });
}
const saved = JSON.parse(readFileSync(marker, 'utf8'));
assert.equal(saved.role, role); assert.deepEqual(files.map(sha), saved.files); assert.equal(sha(payload), saved.payload);
if (role === 'build') {
  for (const path of ['/app/runtime/license/identity.json', '/app/var/keys/ed25519-private.pem', '/app/var/data/appgog.sqlite']) assert.equal(existsSync(path), false);
} else {
  const db = new DatabaseSync('/app/var/data/appgog.sqlite', { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(db.prepare('SELECT count(*) AS total FROM licenses WHERE customer_ref = ?').get('ROLE-BACKUP-CI').total, 1);
  } finally { db.close(); }
}
console.log('独立角色备份内容、配置和身份边界核对通过：' + role);

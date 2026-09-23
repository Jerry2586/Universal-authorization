// Run only in an isolated CI container. Never prints credentials.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadConfig } from '../../apps/license-api/src/config.js';
import { writeZip, readZip } from '../../packages/core/src/zip.js';
const config = loadConfig();
const center = 'http://127.0.0.1:8787';
const build = 'http://build-center:8788';
const marker = '/app/var/uploads/docker-ci.json';
const identity = JSON.parse(readFileSync('/app/runtime/license/identity.json', 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function send(base, path, { body, cookie, csrf, zip } = {}) {
  const response = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { ...(body ? { 'content-type': zip ? 'application/zip' : 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}) },
    ...(body ? { body: zip ? body : JSON.stringify(body) } : {}),
  });
  assert.ok(response.ok, path + ': HTTP ' + response.status);
  return { data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
assert.equal((await fetch(center + '/health')).status, 200);
assert.equal((await fetch(build + '/health')).status, 200);
assert.equal((await fetch(build + '/admin')).status, 404);
assert.equal((await fetch(center + '/build')).status, 404);
const admin = await send(center, '/web/admin/login', { body: { username: config.adminUsername, password: config.adminPassword } });
const adminOptions = { cookie: admin.cookie, csrf: admin.data.csrf_token };
let saved;
if (process.argv[2] === 'create') {
  const zip = writeZip(new Map([
    ['APPGOG/config.json', Buffer.from('{"name":"APPGOG"}')],
    ['APPGOG/index.html', Buffer.from('<!doctype html><html><head></head><body>APPGOG</body></html>')],
  ]));
  await send(center, '/web/admin/versions/upload?version=1.0.0', { ...adminOptions, body: zip, zip: true });
  const issued = await send(center, '/web/admin/licenses', { ...adminOptions, body: { customer_ref: 'DOCKER-CI', domain: 'customer.test' } });
  saved = { licenseKey: issued.data.license_key, identityHash: sha(JSON.stringify(identity)), publicKeyHash: sha(readFileSync(config.publicKeyPath)) };
} else saved = JSON.parse(readFileSync(marker, 'utf8'));
assert.equal(sha(JSON.stringify(identity)), saved.identityHash);
assert.equal(sha(readFileSync(config.publicKeyPath)), saved.publicKeyHash);
if (process.argv[3]) assert.equal(config.publicBaseUrl, process.argv[3]);
const customer = await send(build, '/web/customer/login', { body: { license_key: saved.licenseKey } });
const options = { cookie: customer.cookie, csrf: customer.data.csrf_token };
if (process.argv[2] === 'create') {
  const queued = await send(build, '/web/customer/builds', { ...options, body: { version: '1.0.0', domain: 'customer.test' } });
  saved.jobId = queued.data.id;
}
let detail;
for (let attempt = 0; attempt < 60; attempt++) {
  detail = (await send(build, '/web/customer/builds/' + saved.jobId, options)).data;
  if (detail.status === 'succeeded') break;
  assert.notEqual(detail.status, 'failed', 'Worker 构建失败');
  await new Promise(resolve => setTimeout(resolve, 1000));
}
assert.equal(detail.status, 'succeeded');
assert.match(detail.install_key, /^INS-/);
const response = await fetch(build + '/web/customer/builds/' + saved.jobId + '/download', { headers: { cookie: customer.cookie } });
assert.equal(response.status, 200);
const output = Buffer.from(await response.arrayBuffer());
assert.equal(sha(output), response.headers.get('x-appgog-sha256'));
assert.ok([...readZip(output).keys()].some(path => path.includes('appgog-license/runtime.')));
if (process.argv[2] === 'create') {
  saved.outputHash = sha(output);
  saved.installKey = detail.install_key;
  writeFileSync(marker, JSON.stringify(saved), { mode: 0o600 });
} else {
  assert.equal(sha(output), saved.outputHash);
  assert.equal(detail.install_key, saved.installKey);
}
console.log('Docker 业务验证通过：后台登录、授权登录、真实 Worker 构建、原成品与密钥一致。');

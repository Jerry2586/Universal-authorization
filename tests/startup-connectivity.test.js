import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { clientAddress } from '../packages/core/src/client-address.js';

function isolatedEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(APPGOG_|PORT$|BUILD_CENTER_|PUBLIC_BASE_URL$|NODE_ENV$)/.test(key)));
  return { ...env, APPGOG_SKIP_DOTENV: 'true', NODE_ENV: 'test', ...extra };
}
function config(env, overrides = {}) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import {loadConfig} from './apps/license-api/src/config.js';
    const c=loadConfig(${JSON.stringify(overrides)});
    console.log(JSON.stringify({port:c.port,role:c.role,public:c.publicBaseUrl,build:c.buildCenterPublicUrl}));
  `], { encoding: 'utf8', env: isolatedEnv(env) });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('entry URLs follow role and configured ports without replacing explicit deployment URLs', () => {
  assert.deepEqual(config({ PORT: '9187', BUILD_CENTER_PORT: '9188', APPGOG_ROLE: 'license-center' }),
    { port: 9187, role: 'license-center', public: 'http://127.0.0.1:9187', build: 'http://127.0.0.1:9188/build' });
  assert.equal(config({ PORT: '9187', APPGOG_ROLE: 'all-in-one' }).build, 'http://127.0.0.1:9187/build');
  assert.equal(config({ APPGOG_ROLE: 'all-in-one', PUBLIC_BASE_URL: 'https://auth.example', BUILD_CENTER_PUBLIC_URL: 'https://build.example/build' }).build, 'https://build.example/build');
  assert.equal(config({ APPGOG_ROLE: 'all-in-one' }, { role: 'license-center' }).role, 'license-center');
  for (const port of ['8787oops', '65536', '-1']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', "import {loadConfig} from './apps/license-api/src/config.js';loadConfig();"], { env: isolatedEnv({ PORT: port }), encoding: 'utf8' });
    assert.notEqual(result.status, 0, port);
    assert.match(result.stderr, /PORT/);
  }
});

test('split startup rejects an occupied port before opening the database or spawning services', async t => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const child = spawn(process.execPath, ['scripts/start-split.js'], {
    env: isolatedEnv({ PORT: String(server.address().port), DATABASE_PATH: 'should-not-open.sqlite' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(code, 1);
  assert.match(output, /已被占用或无法绑定/);
  assert.doesNotMatch(output, /listening on/);
});

test('only trusted reverse proxies can supply a client IP', () => {
  const request = (address, forwarded) => ({ socket: { remoteAddress: address }, headers: { 'x-forwarded-for': forwarded } });
  assert.equal(clientAddress(request('203.0.113.5', '192.0.2.23')), '203.0.113.5');
  assert.equal(clientAddress(request('::ffff:127.0.0.1', '192.0.2.23')), '192.0.2.23');
  assert.equal(clientAddress(request('127.0.0.1', 'invalid')), '127.0.0.1');
});

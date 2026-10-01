import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { localSecurityScan } from '../apps/license-api/src/modules/operations/local-security-scan.js';
import { handleOperationsHttp } from '../apps/license-api/src/modules/operations/http-routes.js';

function request(body) { return Object.assign(Readable.from([JSON.stringify(body)]), { headers: {} }); }
function route(method, body, allowed = true) {
  const seen = { status: null, result: null, csrf: null, limits: 0, audit: [] };
  const run = handleOperationsHttp({ method,
    url: new URL('https://example.test/web/admin/security/local-scan'),
    request: request(body), response: {},
    portal: { recordLocalSecurityScan: (state, actorId) => seen.audit.push({ state, actorId }) },
    requireSession: (csrf, permission) => {
      seen.csrf = csrf;
      assert.equal(permission, 'system.manage');
      if (!allowed) throw new Error('denied');
      return { actor_id: 'admin-test' };
    },
    rateLimit: () => { seen.limits++; },
    readJson: async req => JSON.parse((await Array.fromAsync(req)).join('')),
    respondJson: (_res, status, result) => { seen.status = status; seen.result = result; },
  }).then(() => seen);
  return run;
}

test('local scan is unavailable without a host agent and never pretends healthy', async () => {
  const report = await localSecurityScan('status', { APPGOG_HOST_SCAN_SOCKET: '/no-such-appgog-agent.sock' });
  assert.equal(report.state, 'unavailable');
  assert.equal(report.checks, undefined);
  assert.throws(() => localSecurityScan('arbitrary-command'), TypeError);
});

test('local scan requires admin permission and CSRF on writes', async () => {
  await assert.rejects(route('POST', {}, false), /denied/);
  const result = await route('POST', {});
  assert.equal(result.csrf, true);
  assert.equal(result.limits, 1);
  assert.equal(result.result.state, 'unavailable');
  assert.deepEqual(result.audit, [{ state: 'unavailable', actorId: 'admin-test' }]);
  const read = await route('GET', {});
  assert.equal(read.csrf, false);
  assert.deepEqual(read.audit, []);
});

test('local scan rejects browser-selected actions or paths', async () => {
  const result = await route('POST', { path: '/etc/shadow', command: 'cat' });
  assert.equal(result.status, 400);
  assert.match(result.result.error, /自定义/);
  assert.deepEqual(result.audit, []);
});

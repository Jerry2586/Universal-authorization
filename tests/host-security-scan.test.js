import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { LOCAL_SECURITY_REQUIRED_CHECKS, localSecurityScan,
  normalizeLocalSecurityReport } from '../apps/license-api/src/modules/operations/local-security-scan.js';
import { handleOperationsHttp } from '../apps/license-api/src/modules/operations/http-routes.js';

function request(body) { return Object.assign(Readable.from([JSON.stringify(body)]), { headers: {} }); }
function completeChecks(updates = {}) {
  return LOCAL_SECURITY_REQUIRED_CHECKS.map(name => ({ name, state: 'ok', detail: 'matched', ...(updates[name] || {}) }));
}
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

test('stale local reports never hide warnings, findings, or unavailable checks', () => {
  const now = Date.parse('2026-10-02T12:00:00.000Z');
  const report = normalizeLocalSecurityReport({ state: 'finished', checked_at: '2026-10-02T11:30:00.000Z', checks: completeChecks({
    '监听端口变化': { state: 'warning', detail: 'changed' },
    '业务容器运行配置': { state: 'finding', detail: 'unsafe' },
    '本机备份': { state: 'unavailable', detail: 'missing' },
  }) }, 200, now);
  assert.equal(report.stale, true);
  assert.equal(report.summary_state, 'finding');
  assert.match(report.reason, /过期/);
  assert.equal(report.checks.find(item => item.name === '核心文件完整性').state, 'stale');
  assert.equal(report.checks.find(item => item.name === '监听端口变化').state, 'warning');
  assert.equal(report.checks.find(item => item.name === '业务容器运行配置').state, 'finding');
  assert.equal(report.checks.find(item => item.name === '本机备份').state, 'unavailable');
});

test('local report summary preserves the highest-severity check state', () => {
  const checked_at = '2026-10-02T12:00:00.000Z';
  const now = Date.parse(checked_at);
  const normalize = updates => normalizeLocalSecurityReport({ state: 'finished', checked_at,
    checks: completeChecks(updates) }, 200, now);
  assert.equal(normalize().summary_state, 'ok');
  assert.equal(normalize({ '核心文件完整性': { state: 'stale', detail: 'old' } }).summary_state, 'stale');
  assert.equal(normalize({ '核心文件完整性': { state: 'warning', detail: 'review' },
    '本机备份': { state: 'stale', detail: 'old' } }).summary_state, 'warning');
  assert.equal(normalize({ '核心文件完整性': { state: 'unavailable', detail: 'missing' },
    '监听端口变化': { state: 'warning', detail: 'review' } }).summary_state, 'unavailable');
  assert.equal(normalize({ '业务容器运行配置': { state: 'finding', detail: 'unsafe' },
    '核心文件完整性': { state: 'unavailable', detail: 'missing' } }).summary_state, 'finding');
  assert.equal(normalizeLocalSecurityReport({ state: 'running', checks: [] }, 202, now).summary_state, 'warning');
  assert.equal(normalizeLocalSecurityReport({ state: 'failed', checks: [] }, 409, now).summary_state, 'unavailable');
});

test('local report normalization rejects invalid states and bounds browser-visible text', () => {
  assert.equal(normalizeLocalSecurityReport({ state: 'compromised' }, 200).state, 'unavailable');
  assert.equal(normalizeLocalSecurityReport({ state: 'finished' }, 500).state, 'unavailable');
  const report = normalizeLocalSecurityReport({ state: 'finished', checked_at: new Date().toISOString(), checks: [
    ...completeChecks(),
    { name: 'n'.repeat(100), state: 'ok', detail: 'd'.repeat(300) },
    { name: 'invalid', state: 'compromised', detail: 'discard me' },
  ] }, 200);
  const bounded = report.checks.find(item => item.name.startsWith('n'));
  assert.equal(bounded.name.length, 60);
  assert.equal(bounded.detail.length, 180);
  assert.ok(!report.checks.some(item => item.name === 'invalid'));
});

test('finished local reports fail closed when checks are missing, duplicated, or unknown', () => {
  const checked_at = '2026-10-02T12:00:00.000Z';
  const now = Date.parse(checked_at);
  const full = completeChecks();
  for (const checks of [[], full.slice(1), [...full.slice(1), full[1]],
    [...full.slice(1), { name: '未知检查', state: 'ok', detail: 'ignored' }]]) {
    const report = normalizeLocalSecurityReport({ state: 'finished', checked_at, checks }, 200, now);
    assert.equal(report.summary_state, 'unavailable');
    assert.match(report.reason, /不完整/);
    assert.ok(report.checks.some(item => item.name === '检查报告完整性'));
  }
});

test('finished reports with missing or future timestamps are stale', () => {
  const now = Date.parse('2026-10-02T12:00:00.000Z');
  const missing = normalizeLocalSecurityReport({ state: 'finished', checks: completeChecks() }, 200, now);
  const future = normalizeLocalSecurityReport({ state: 'finished', checked_at: '2026-10-02T12:06:00.000Z', checks: completeChecks() }, 200, now);
  assert.equal(missing.stale, true);
  assert.equal(missing.summary_state, 'stale');
  assert.equal(future.stale, true);
  assert.equal(future.summary_state, 'stale');
});

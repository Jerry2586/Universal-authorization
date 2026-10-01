import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeHostScan } from '../scripts/security-agent.js';

test('host report summary discards paths and error details and fails closed', () => {
  const checked_at = new Date().toISOString();
  assert.deepEqual(summarizeHostScan({ state: 'finished', checked_at, checks: [
    { name: 'core', state: 'ok', detail: '/private/path' },
    { name: 'engine', state: 'finding', detail: 'secret' },
  ] }), { state: 'finding', checked_at, counts: { ok: 1, warning: 0, finding: 1, unavailable: 0 } });
  assert.deepEqual(summarizeHostScan({ state: 'failed', reason: 'private path' }), { state: 'unavailable', checked_at: null });
  assert.deepEqual(summarizeHostScan({ state: 'finished', checked_at: 'bad', checks: [] }), { state: 'unavailable', checked_at: null });
});

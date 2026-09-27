import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuotaView } from '../apps/web/public/assets/portal/quota-view.js';

test('both portal quota views use the tighter total and rolling-day limit', () => {
  const customer = { max_builds_per_day: 5, builds_used_last_24_hours: 1, max_builds_total: 10, total_builds_used: 9 };
  const admin = { ...customer, total_builds_used: undefined, build_count: 9 };
  assert.equal(buildQuotaView(customer).available, 1);
  assert.deepEqual(buildQuotaView(admin), buildQuotaView(customer));
  assert.equal(buildQuotaView({ ...customer, total_builds_used: 10 }).available, 0);
  assert.match(buildQuotaView({ ...customer, total_builds_used: 10 }).reason, /总额度已用完/);
  assert.equal(buildQuotaView({ ...customer, builds_used_last_24_hours: 5 }).available, 0);
  assert.match(buildQuotaView({ ...customer, builds_used_last_24_hours: 5 }).reason, /滚动恢复/);
});
test('unlimited total still obeys rolling-day limit, unknown fields do not fabricate remaining quota', () => {
  assert.equal(buildQuotaView({ max_builds_per_day: 3, builds_used_last_24_hours: 1, max_builds_total: null }).available, 2);
  assert.equal(buildQuotaView({ max_builds_per_day: 3, builds_used_last_24_hours: 1 }).available, null);
  assert.equal(buildQuotaView({ max_builds_per_day: 3, builds_used_last_24_hours: 1, max_builds_total: 10, total_builds_used: null }).available, null);
  assert.equal(buildQuotaView({ max_builds_per_day: 3, builds_used_last_24_hours: 9, max_builds_total: null }).available, 0);
});

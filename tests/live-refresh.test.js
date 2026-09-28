import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLiveRefreshScheduler, hasActiveBuilds, mergeLiveBuildHistory,
} from '../apps/web/public/assets/portal/live-refresh.js';

test('live refresh uses fast polling for queued and processing builds and survives transient failures', async () => {
  const timers = [];
  const cleared = new Set();
  let data = { builds: [] };
  let calls = 0;
  let failOnce = false;
  const scheduler = createLiveRefreshScheduler({
    refresh: async () => {
      calls += 1;
      if (failOnce) { failOnce = false; throw new Error('temporary restart'); }
    },
    canRefresh: () => true,
    isActive: () => hasActiveBuilds(data),
    setTimer: (fn, delay) => {
      const token = { fn, delay };
      timers.push(token);
      return token;
    },
    clearTimer: (token) => cleared.add(token),
  });

  scheduler.start();
  assert.equal(timers.at(-1).delay, 15000);
  data = { builds: [{ id: 'job-1', status: 'queued' }] };
  scheduler.reschedule();
  assert.equal(timers.at(-1).delay, 2000);

  failOnce = true;
  await timers.at(-1).fn();
  assert.equal(calls, 1);
  assert.equal(timers.at(-1).delay, 2000, 'failed refresh keeps the fast polling loop alive');

  data.builds[0].status = 'succeeded';
  await timers.at(-1).fn();
  assert.equal(calls, 2);
  assert.equal(timers.at(-1).delay, 15000);
  scheduler.stop();
  assert.ok(cleared.size >= 1);
});

test('active build detection ignores completed jobs and accepts both live states', () => {
  assert.equal(hasActiveBuilds({ builds: [{ status: 'succeeded' }] }), false);
  assert.equal(hasActiveBuilds({ builds: [{ status: 'queued' }] }), true);
  assert.equal(hasActiveBuilds({ builds: [{ status: 'processing' }] }), true);
  assert.equal(hasActiveBuilds(null), false);
});

test('live build history merges progress and prepends matching active jobs', () => {
  const history = [
    { id: 'known', version: '1.2.52', status: 'queued', progress: 10 },
    { id: 'old', version: '1.2.50', status: 'succeeded', progress: 100 },
  ];
  const builds = [
    { id: 'known', version: '1.2.52', status: 'processing', progress: 65 },
    { id: 'new', version: '1.2.53', domain: 'demo.example.com', status: 'queued', progress: 0 },
    { id: 'done', version: '1.2.51', status: 'succeeded', progress: 100 },
  ];

  assert.deepEqual(mergeLiveBuildHistory(history, builds).map((job) => [job.id, job.status, job.progress]), [
    ['new', 'queued', 0],
    ['known', 'processing', 65],
    ['old', 'succeeded', 100],
  ]);
  assert.deepEqual(mergeLiveBuildHistory(history, builds, 'demo.example.com').map((job) => job.id), [
    'new', 'known', 'old',
  ]);
});

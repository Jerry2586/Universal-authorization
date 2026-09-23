import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveWorkerToken } from '../apps/build-worker/src/server.js';

const shared = 'shared-worker-test-credential-longer-than-32';
const node = 'dedicated-node-test-credential-longer-than-32';

test('Worker falls back to shared token when Compose supplies an empty node token', () => {
  for (const value of [undefined, '']) {
    assert.equal(resolveWorkerToken({ NODE_ENV: 'production', WORKER_NODE_TOKEN: value, WORKER_TOKEN: shared }), shared);
  }
});

test('Worker prefers explicit node credentials and does not mask invalid credentials', () => {
  assert.equal(resolveWorkerToken({ WORKER_NODE_TOKEN: node, WORKER_TOKEN: shared }), node);
  assert.throws(() => resolveWorkerToken({ WORKER_NODE_TOKEN: 'invalid', WORKER_TOKEN: shared }), /Worker/);
});

test('Worker rejects missing and development credentials in production', () => {
  for (const token of [undefined, '', 'short', 'development-worker-token-longer-than-32-characters', 'replace-with-worker-token-longer-than-32-characters']) {
    assert.throws(() => resolveWorkerToken({ NODE_ENV: 'production', WORKER_NODE_TOKEN: '', WORKER_TOKEN: token }), /Worker/);
  }
});

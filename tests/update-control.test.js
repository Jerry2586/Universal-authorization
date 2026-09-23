import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createUpdateControl } from '../apps/license-api/src/update-control.js';

test('online update control requires a live helper, validates actions, and prevents duplicate queueing', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'appgog-update-control-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = new Date('2026-09-23T09:00:00.000Z');
  const control = createUpdateControl({ root, currentVersion: '1.2.0', clock: () => now });

  assert.equal(control.status().available, false);
  assert.throws(() => control.enqueue('run-shell'), (error) => error.code === 'UPDATE_ACTION_INVALID');
  assert.throws(() => control.enqueue('check-update'), (error) => error.code === 'UPDATE_HELPER_UNAVAILABLE');

  writeFileSync(join(root, 'status.json'), JSON.stringify({
    state: 'idle', heartbeat_at: now.toISOString(), current_version: '1.2.0', message: 'ready',
  }));
  const request = control.enqueue('install-version', 'v1.2.1');
  assert.match(request.id, /^upd_[0-9a-f]{32}$/);
  assert.equal(request.version, '1.2.1');
  const requestFiles = readdirSync(join(root, 'requests'));
  assert.deepEqual(requestFiles, [`${request.id}.json`]);
  assert.equal(JSON.parse(readFileSync(join(root, 'status.json'), 'utf8')).state, 'queued');
  assert.throws(() => control.enqueue('repair-current'), (error) => error.code === 'UPDATE_ALREADY_RUNNING');
});

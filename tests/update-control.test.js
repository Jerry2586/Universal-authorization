import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createUpdateControl } from '../apps/license-api/src/update-control.js';

test('online update control requires a fresh signed release before installation and prevents duplicate queueing', (t) => {
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
  assert.equal(control.status().freshness, 'unchecked');
  assert.equal(control.status().installable, false);
  assert.throws(() => control.enqueue('install-version', 'v1.2.1'), (error) => error.code === 'UPDATE_RELEASE_NOT_READY');

  writeFileSync(join(root, 'status.json'), JSON.stringify({
    schema: 2,
    state: 'idle',
    heartbeat_at: now.toISOString(),
    current_version: '1.2.0',
    latest_version: '1.2.1',
    check_status: 'succeeded',
    checked_at: now.toISOString(),
    source: 'signed-release',
    message: 'ready',
  }));
  assert.equal(control.status().relation, 'update_available');
  assert.equal(control.status().installable, true);
  const request = control.enqueue('install-version', 'v1.2.1');
  assert.match(request.id, /^upd_[0-9a-f]{32}$/);
  assert.equal(request.version, '1.2.1');
  const requestFiles = readdirSync(join(root, 'requests'));
  assert.deepEqual(requestFiles, [`${request.id}.json`]);
  assert.equal(JSON.parse(readFileSync(join(root, 'status.json'), 'utf8')).state, 'queued');
  assert.throws(() => control.enqueue('repair-current'), (error) => error.code === 'UPDATE_ALREADY_RUNNING');
});

test('online update control rejects stale, failed, equal, and source-behind release state', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'appgog-update-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = new Date('2026-09-25T12:00:00.000Z');
  const control = createUpdateControl({ root, currentVersion: '1.2.23', clock: () => now });
  const writeStatus = (overrides) => writeFileSync(join(root, 'status.json'), JSON.stringify({
    schema: 2,
    state: 'idle',
    heartbeat_at: now.toISOString(),
    latest_version: '1.2.24',
    check_status: 'succeeded',
    checked_at: now.toISOString(),
    source: 'signed-release',
    ...overrides,
  }));

  writeStatus({ checked_at: '2026-09-25T10:59:59.000Z' });
  assert.equal(control.status().freshness, 'stale');
  assert.throws(() => control.enqueue('install-version'), (error) => error.code === 'UPDATE_CHECK_STALE');

  writeStatus({ latest_version: null, check_status: 'failed', last_error: 'network unavailable' });
  assert.equal(control.status().freshness, 'failed');
  assert.throws(() => control.enqueue('install-version'), (error) => error.code === 'UPDATE_RELEASE_NOT_READY');

  writeStatus({ latest_version: '1.2.23' });
  assert.equal(control.status().relation, 'up_to_date');
  assert.throws(() => control.enqueue('install-version'), (error) => error.code === 'UPDATE_NO_UPDATE');

  writeStatus({ latest_version: '1.2.22' });
  assert.equal(control.status().relation, 'source_behind');
  assert.throws(() => control.enqueue('install-version'), (error) => error.code === 'UPDATE_SOURCE_BEHIND');
});

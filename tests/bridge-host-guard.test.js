import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('persistent host guard: signed activation, plugin removal, recovery, legacy upgrade and bootstrap idempotence', () => {
  const root = mkdtempSync(join(tmpdir(), 'appgog-host-guard-'));
  try {
    const result = spawnSync(process.env.APPGOG_TEST_PHP || 'php', [
      resolve('tests/fixtures/bridge-host-guard.php'),
      resolve('apps/build-worker/xboard-bridge/AppgogLicenseBridge'), root,
    ], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /host guard cases passed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

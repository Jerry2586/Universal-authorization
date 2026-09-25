import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('bridge upgrade reload waits for committed enabled plugin, preserves records and reports failures', () => {
  const result = spawnSync(process.env.APPGOG_TEST_PHP || 'php', [
    resolve('tests/fixtures/bridge-reload.php'),
    resolve('apps/build-worker/xboard-bridge/AppgogLicenseBridge/database/migrations/2026_09_26_000001_reload_appgog_bridge_runtime.php'),
  ], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /7 bridge reload cases passed/);
});

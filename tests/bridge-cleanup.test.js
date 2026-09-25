import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('PHP bridge cleanup preserves replaced, activated and unrelated themes', () => {
  const php = process.env.APPGOG_TEST_PHP || 'php';
  const probe = spawnSync(php, ['-v'], { encoding: 'utf8' });
  assert.equal(probe.status, 0, 'PHP is required: set APPGOG_TEST_PHP or install PHP in PATH');
  const dir = mkdtempSync(join(tmpdir(), 'appgog-bridge-'));
  try {
    const result = spawnSync(php, [resolve('tests/fixtures/bridge-cleanup.php'),
      resolve('apps/build-worker/xboard-bridge/AppgogLicenseBridge/Services/BridgeState.php'), dir],
      { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /9 bridge cleanup cases passed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

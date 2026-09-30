import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
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

test('Windows bridge PHP can uninstall an existing Linux bootstrap registration', () => {
  const root = mkdtempSync(join(tmpdir(), 'appgog-host-crlf-'));
  try {
    const plugin = join(root, 'plugin');
    cpSync(resolve('apps/build-worker/xboard-bridge/AppgogLicenseBridge'), plugin, { recursive: true });
    const helper = join(plugin, 'Services/HostIntegration.php');
    writeFileSync(helper, readFileSync(helper, 'utf8').replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'));
    const result = spawnSync(process.env.APPGOG_TEST_PHP || 'php', [
      resolve('tests/fixtures/bridge-host-guard.php'), plugin, join(root, 'host'),
    ], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /host guard cases passed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

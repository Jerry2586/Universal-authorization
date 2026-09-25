import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { checkHealth } from '../scripts/docker/health.js';
import { PACKAGE_VERSION } from '../packages/core/src/version.js';

const root = resolve(import.meta.dirname, '..');
const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
const shellPath = path => path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase());
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

for (const repair of [false, true]) {
  test('signed updater preserves exit status and ' + (repair ? 'repair pin' : 'clears inherited version pin'), t => {
    if (!existsSync(shell)) return t.skip('POSIX shell unavailable');
    const directory = mkdtempSync(join(tmpdir(), 'appgog-updater-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(join(directory, 'install-docker.sh'), '#!/bin/sh\nprintf "version=%s repair=%s\\n" "$APPGOG_VERSION" "$APPGOG_REPAIR_SOURCE"\nexit 37\n');
    const command = '. ' + quote(shellPath(join(root, 'scripts/lib/signed-update.sh'))) + '\n' +
      'appgog_run_signed_update ' + [shellPath(directory), shellPath(directory), repair ? '1.2.14' : '', String(repair), shellPath(join(directory, 'update.log'))].map(quote).join(' ');
    const result = spawnSync(shell, ['-c', command], { encoding: 'utf8', env: { ...process.env, APPGOG_VERSION: '1.2.10' } });
    assert.equal(result.status, 37, result.stderr);
    assert.match(readFileSync(join(directory, 'update.log'), 'utf8'), repair ? /version=1\.2\.14 repair=true/ : /version= repair=false/);
  });
}

test('stdin bootstrap in an old checkout never executes its local installer', t => {
  if (!existsSync(shell)) return t.skip('POSIX shell unavailable');
  const directory = mkdtempSync(join(tmpdir(), 'appgog-old-bootstrap-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'scripts'));
  writeFileSync(join(directory, 'scripts/install-linux.sh'), 'echo WRONG_LOCAL_INSTALL\nexit 23\n');
  // Force a harmless root check rejection immediately after source detection.
  const input = 'id() { echo 12345; }\n' + readFileSync(join(root, 'install-docker.sh'), 'utf8');
  const result = spawnSync(shell, [], { cwd: directory, input, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /WRONG_LOCAL_INSTALL/);
  assert.match(result.stderr, /root/);
});

test('Docker readiness rejects old API or upstream versions despite HTTP 200', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'appgog-health-version-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const state = join(directory, 'state.json');
  writeFileSync(state, JSON.stringify({ ready: true, pids: Array(4).fill(process.pid) }));
  t.mock.method(globalThis, 'fetch', async url => new Response(JSON.stringify({ version: url.includes('8787') ? '1.2.10' : PACKAGE_VERSION, upstream_version: PACKAGE_VERSION })));
  await assert.rejects(checkHealth(state), /运行版本不一致/);
  globalThis.fetch.mock.mockImplementation(async () => new Response(JSON.stringify({ version: PACKAGE_VERSION, upstream_version: '1.2.10' })));
  await assert.rejects(checkHealth(state), /运行版本不一致/);
  globalThis.fetch.mock.mockImplementation(async () => new Response(JSON.stringify({ version: PACKAGE_VERSION, upstream_version: PACKAGE_VERSION })));
  await checkHealth(state);
});

test('all shipped shell scripts parse with the available POSIX shell', async t => {
  if (!existsSync(shell)) return t.skip('POSIX shell unavailable');
  const { readdirSync } = await import('node:fs');
  const files = [join(root, 'install-docker.sh')];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(directory, entry.name));
      else if (entry.name.endsWith('.sh')) files.push(join(directory, entry.name));
    }
  }
  walk(join(root, 'scripts'));
  for (const file of files) {
    const result = spawnSync(shell, ['-n', shellPath(file)], { encoding: 'utf8' });
    assert.equal(result.status, 0, file + '\n' + result.stderr);
  }
});

test('helper installer reports an actual failed install instead of cleanup success', t => {
  if (!existsSync(shell)) return t.skip('POSIX shell unavailable');
  const directory = mkdtempSync(join(tmpdir(), 'appgog-helper-failure-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'install-docker.sh'), 'echo FAILED_INSTALL\nexit 37\n');
  const helper = readFileSync(join(root, 'scripts/update-helper.sh'), 'utf8');
  const runner = helper.match(/run_installer\(\) \{[\s\S]*?\n\}/)[0];
  const command = '. ' + quote(shellPath(join(root, 'scripts/lib/signed-update.sh'))) + '\n' +
    'CURRENT_LINK=' + quote(shellPath(directory)) + '\nINSTALL_ROOT="$CURRENT_LINK"\nLOG_FILE="$CURRENT_LINK/update.log"\n' +
    'write_status() { :; }\nsleep() { command sleep 0.05; }\n' + runner + '\nif run_installer ""; then exit 0; else exit $?; fi';
  const result = spawnSync(shell, ['-c', command], { encoding: 'utf8' });
  assert.equal(result.status, 37, result.stderr);
});

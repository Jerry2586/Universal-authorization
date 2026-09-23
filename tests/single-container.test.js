import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { supervise } from '../scripts/docker/supervisor.js';
import { createInstaller } from '../scripts/package-installer.js';
import { writeZip } from '../packages/core/src/zip.js';
const child = name => ({ name, command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] });
const options = { log: () => {}, shutdownMs: 500, monitorMs: 10 };
test('Supervisor stops every child on requested shutdown', { timeout: 5000 }, async () => {
  const app = supervise({ ...options, specs: [child('one'), child('two')] });
  await app.ready;
  assert.equal(app.children.length, 2);
  app.stop();
  assert.equal(await app.done, 0);
  assert.ok(app.children.every(c => c.exitCode !== null || c.signalCode !== null));
});
test('Supervisor shuts siblings down when a process exits', { timeout: 5000 }, async () => {
  const app = supervise({ ...options, specs: [child('one'), { ...child('two'), args: ['-e', 'setTimeout(()=>process.exit(7),100)'] }] });
  await app.ready;
  assert.equal(await app.done, 1);
  assert.ok(app.children.every(c => c.exitCode !== null || c.signalCode !== null));
});
test('Spawn failure resolves shutdown instead of leaving a half-running container', { timeout: 5000 }, async () => {
  const app = supervise({ ...options, specs: [child('one'), { name: 'missing', command: 'appgog-nonexistent-executable', args: [] }] });
  await assert.rejects(app.ready);
  assert.equal(await app.done, 1);
});
test('Persistent failed health probes terminate the container', { timeout: 5000 }, async () => {
  let probes = 0;
  const app = supervise({ ...options, specs: [child('one')], probe: async () => { probes++; throw Error('failed'); } });
  await app.ready;
  assert.equal(await app.done, 1);
  assert.equal(probes, 3);
});
test('Self-extracting installer contains the exact checksummed archive', () => {
  const zip = writeZip(new Map([['release/scripts/install-linux.sh', Buffer.from('exit 0\n')]]));
  const installer = createInstaller(zip, 'release').toString();
  const payload = installer.split('\n__APPGOG_ARCHIVE_BELOW__\n')[1];
  assert.deepEqual(Buffer.from(payload, 'base64'), zip);
  assert.ok(installer.includes(createHash('sha256').update(zip).digest('hex')));
  assert.throws(() => createInstaller(zip, '../escape'));
});
test('Linux installer extracts, forwards args, and rejects corrupt payload before execution', { skip: process.platform === 'win32' }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'appgog-run-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'id'), '#!/bin/sh\necho 0\n', { mode: 0o755 });
  const script = '#!/bin/sh\nprintf "%s\\n" "$@" > "$TEST_OUTPUT"\n';
  const zip = writeZip(new Map([['release/scripts/install-linux.sh', Buffer.from(script)]]));
  const file = join(dir, 'installer.run');
  const installer = createInstaller(zip, 'release').toString();
  writeFileSync(file, installer);
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH, TEST_OUTPUT: join(dir, 'args') };
  let result = spawnSync('/bin/sh', [file, '--no-menu', 'with space'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(readFileSync(env.TEST_OUTPUT, 'utf8'), /--source-dir\n.*release\n--no-menu\nwith space\n/);
  rmSync(env.TEST_OUTPUT);
  const marker = '\n__APPGOG_ARCHIVE_BELOW__\n';
  const [header, payload] = installer.split(marker);
  writeFileSync(file, header + marker + (payload[0] === 'A' ? 'B' : 'A') + payload.slice(1));
  result = spawnSync('/bin/sh', [file], { env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.throws(() => readFileSync(env.TEST_OUTPUT));
});

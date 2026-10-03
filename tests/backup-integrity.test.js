import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, symlinkSync, linkSync, cpSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { python, openssl, helper, realBackup, decryptBackup, checked } from './helpers/authenticated-backup.js';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'appgog-backup-auth-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const key = join(root, 'key');
  writeFileSync(key, 'A'.repeat(64) + '\n', { mode: 0o600 });
  const cipher = join(root, 'cipher');
  writeFileSync(cipher, Buffer.concat([Buffer.from('Salted__'), Buffer.alloc(64, 42)]));
  return { root, key, cipher, archive: join(root, 'backup.tar.gz.enc'), output: join(root, 'opened') };
}
function run(f, action, input = f.archive, output = f.output, extras = []) {
  const result = spawnSync(python, ['-X', 'utf8', '-I', helper, action, '--key', f.key, '--input', input, ...(action === 'verify' ? [] : ['--output', output]), ...extras], { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}
function seal(f) { const result = run(f, 'seal', f.cipher, f.archive); assert.equal(result.status, 0, result.stderr); }

test('authenticated backup round-trip, verification and CRLF/migration key compatibility', t => {
  const f = fixture(t); seal(f);
  assert.equal(run(f, 'verify').status, 0);
  writeFileSync(f.key, 'A'.repeat(64) + '\r\n');
  const opened = run(f, 'open'); assert.equal(opened.status, 0, opened.stderr);
  assert.deepEqual(readFileSync(f.output), readFileSync(f.cipher));
  rmSync(f.output); writeFileSync(f.key, 'A'.repeat(64));
  assert.equal(run(f, 'open').status, 0);
});

for (const kind of ['header', 'salt', 'ciphertext', 'tag', 'truncate', 'append', 'wrong-key', 'strip-auth']) {
  test('restore authentication rejects ' + kind + ' and leaves no output', t => {
    const f = fixture(t); seal(f); let bytes = readFileSync(f.archive);
    if (kind === 'wrong-key') writeFileSync(f.key, 'B'.repeat(64));
    else if (kind === 'truncate') bytes = bytes.subarray(0, bytes.length - 1);
    else if (kind === 'append') bytes = Buffer.concat([bytes, Buffer.from('x')]);
    else if (kind === 'strip-auth') bytes = bytes.subarray(31, bytes.length - 32);
    else { const index = { header: 0, salt: 15, ciphertext: 45, tag: bytes.length - 1 }[kind]; bytes[index] ^= 1; }
    writeFileSync(f.archive, bytes);
    assert.notEqual(run(f, 'verify').status, 0);
    assert.notEqual(run(f, 'open').status, 0);
    assert.equal(existsSync(f.output), false);
  });
}

test('legacy salted backup requires explicit opt-in and cannot pass authenticated verify', t => {
  const f = fixture(t);
  assert.notEqual(run(f, 'open', f.cipher).status, 0);
  const result = run(f, 'open', f.cipher, f.output, ['--allow-legacy']);
  assert.equal(result.status, 0, result.stderr); assert.match(result.stderr, /未认证/);
  assert.deepEqual(readFileSync(f.output), readFileSync(f.cipher));
  assert.notEqual(run(f, 'verify', f.cipher).status, 0);
});

test('corrupt modern envelope never falls back to legacy, even with opt-in', t => {
  const f = fixture(t); seal(f); const bytes = readFileSync(f.archive); bytes[0] ^= 1; writeFileSync(f.archive, bytes);
  assert.notEqual(run(f, 'open', f.archive, f.output, ['--allow-legacy']).status, 0);
  assert.equal(existsSync(f.output), false);
});

test('refuses output overwrite, malformed key and non-salted payload', t => {
  const f = fixture(t); seal(f); writeFileSync(f.output, 'keep');
  assert.notEqual(run(f, 'open').status, 0); assert.equal(readFileSync(f.output, 'utf8'), 'keep');
  rmSync(f.output); writeFileSync(f.key, 'bad'); assert.notEqual(run(f, 'open').status, 0);
  writeFileSync(f.key, 'A'.repeat(64)); writeFileSync(f.cipher, 'foreign'); rmSync(f.archive);
  assert.notEqual(run(f, 'seal', f.cipher, f.archive).status, 0); assert.equal(existsSync(f.archive), false);
});

test('Linux rejects symlink and hardlink archives, unsafe key permissions and output links', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); seal(f);
  const linked = join(f.root, 'linked'); symlinkSync(f.archive, linked);
  assert.notEqual(run(f, 'open', linked).status, 0); rmSync(linked); linkSync(f.archive, linked);
  assert.notEqual(run(f, 'open').status, 0); rmSync(linked);
  chmodSync(f.key, 0o644); assert.notEqual(run(f, 'open').status, 0); chmodSync(f.key, 0o600);
  symlinkSync(f.cipher, f.output); assert.notEqual(run(f, 'open').status, 0);
  assert.deepEqual(readFileSync(f.cipher), Buffer.concat([Buffer.from('Salted__'), Buffer.alloc(64, 42)]));
});


test('real OpenSSL encryption, authenticated opening and decryption preserve business bytes', t => {
  const f = fixture(t);
  const payload = Buffer.concat([Buffer.from('SQLite/WAL/identity fixture\n'), Buffer.alloc(1024 * 1024 + 17, 83)]);
  const real = realBackup(f.root, payload);
  for (const ending of ['\n', '\r\n', '']) {
    writeFileSync(real.key, real.keyValue + ending);
    const output = join(f.root, 'roundtrip-' + ending.length);
    checked(python, ['-X', 'utf8', '-I', helper, 'open', '--key', real.key, '--input', real.archive, '--output', output]);
    assert.deepEqual(decryptBackup(real.key, output), payload);
  }
  const legacy = join(f.root, 'legacy-opened');
  checked(python, ['-X', 'utf8', '-I', helper, 'open', '--key', real.key, '--input', real.cipher, '--output', legacy, '--allow-legacy']);
  assert.deepEqual(decryptBackup(real.key, legacy), payload);
});

test('key must contain exactly one value with at most one LF or CRLF terminator', t => {
  const f = fixture(t); seal(f);
  for (const value of ['A'.repeat(64) + '\n\n', 'A'.repeat(64) + '\nextra', 'A'.repeat(64) + '\r', 'A'.repeat(257), 'A'.repeat(31)]) {
    writeFileSync(f.key, value);
    assert.notEqual(run(f, 'verify').status, 0);
  }
});

test('same-inode mutation after MAC read is rejected without retaining output', t => {
  const f = fixture(t); seal(f);
  const script =     'import importlib.util,sys\n' +
    'spec=importlib.util.spec_from_file_location("backup",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\n' +
    'original=m.copy_bytes\n' +
    'def mutate(source,target,count,mac=None):\n' +
    '    original(source,target,count,mac)\n' +
    '    with open(sys.argv[3],"r+b") as changed: changed.seek(35); changed.write(b"X")\n' +
    'm.copy_bytes=mutate\n' +
    'm.envelope("open",sys.argv[2],sys.argv[3],sys.argv[4])\n';
  const result = spawnSync(python, ['-X', 'utf8', '-I', '-c', script, helper, f.key, f.archive, f.output], { encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /读取期间文件发生变化/);
  assert.equal(existsSync(f.output), false);
});

test('Linux shell rejects tampered and legacy backups before decryption, build or volume restoration', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); const real = realBackup(f.root);
  const root = join(f.root, 'project'); const bin = join(f.root, 'bin'); const temporary = join(f.root, 'tmp');
  mkdirSync(join(root, 'scripts'), { recursive: true }); mkdirSync(bin); mkdirSync(temporary);
  for (const name of ['docker.sh', 'backup-integrity.py']) cpSync(resolve('scripts', name), join(root, 'scripts', name));
  cpSync(resolve('scripts/lib'), join(root, 'scripts/lib'), { recursive: true });
  writeFileSync(join(root, '.env'), 'AUTH_DOMAIN=sq.example.test\nBUILD_DOMAIN=db.example.test\n');
  writeFileSync(join(root, 'compose.yaml'), 'services: {}\n');
  const log = join(f.root, 'docker.log'); const decryptLog = join(f.root, 'openssl.log');
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\nprintf "%s\n" "$*" >> "$APPGOG_TEST_DOCKER_LOG"\ncase "$*" in "compose version"*) echo v2.24.6 ;; esac\n', { mode: 0o700 });
  writeFileSync(join(bin, 'openssl'), '#!/bin/sh\necho decrypt >> "$APPGOG_TEST_DECRYPT_LOG"\nexit 99\n', { mode: 0o700 });
  const corrupt = join(f.root, 'tampered.tar.gz.enc'); const bytes = Buffer.from(real.bytes); bytes[45] ^= 1; writeFileSync(corrupt, bytes);
  const legacy = join(f.root, 'legacy.tar.gz.enc'); cpSync(real.cipher, legacy);
  const plaintext = join(f.root, 'unsafe-legacy.tar.gz'); writeFileSync(plaintext, 'legacy payload');
  const plaintextLink = join(f.root, 'legacy-link.tar.gz'); symlinkSync(plaintext, plaintextLink);
  const plaintextHardlink = join(f.root, 'legacy-hardlink.tar.gz'); linkSync(plaintext, plaintextHardlink);
  for (const [archive, optIn] of [[corrupt, false], [corrupt, true], [legacy, false], [plaintextLink, true], [plaintextHardlink, true], [plaintext, true]]) {
    writeFileSync(log, '');
    const result = spawnSync('sh', [join(root, 'scripts/docker.sh'), 'restore', archive], { encoding: 'utf8', env: { ...process.env, PATH: bin + ':' + process.env.PATH, TMPDIR: temporary, APPGOG_BACKUP_KEY_FILE: real.key, APPGOG_TEST_DOCKER_LOG: log, APPGOG_TEST_DECRYPT_LOG: decryptLog, APPGOG_ALLOW_LEGACY_BACKUP: String(optIn) } });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /备份认证失败/);
    assert.equal(existsSync(decryptLog), false);
    assert.doesNotMatch(readFileSync(log, 'utf8'), /build| run | up /);
    assert.equal(existsSync(join(root, 'shared')), false); assert.deepEqual(readdirSync(temporary), []);
  }
  const verify = spawnSync('sh', [join(root, 'scripts/docker.sh'), 'backup-verify', real.archive], { encoding: 'utf8', env: { ...process.env, PATH: bin + ':' + process.env.PATH, APPGOG_BACKUP_KEY_FILE: real.key, APPGOG_TEST_DOCKER_LOG: log } });
  assert.equal(verify.status, 0, verify.stderr); assert.equal(existsSync(decryptLog), false);
});


test('Linux decrypt uses authenticated anonymous ciphertext and the same key snapshot', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); const real = realBackup(f.root);
  checked(python, ['-I', helper, 'decrypt', '--key', real.key, '--input', real.archive, '--output', f.output]);
  assert.deepEqual(readFileSync(f.output), real.payload); rmSync(f.output);
  const script = 'import importlib.util,sys,os\n' +
    'spec=importlib.util.spec_from_file_location("backup",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\n' +
    'original=m.subprocess.run\n' +
    'def replace(*args,**kwargs):\n' +
    '    with open(sys.argv[2],"wb") as f: f.write(b"B"*64+b"\\n")\n' +
    '    os.rename(sys.argv[3],sys.argv[3]+".original")\n' +
    '    with open(sys.argv[3],"wb") as f: f.write(b"untrusted replacement")\n' +
    '    return original(*args,**kwargs)\n' +
    'm.subprocess.run=replace\n' +
    'm.envelope("decrypt",sys.argv[2],sys.argv[3],sys.argv[4])\n';
  checked(python, ['-I', '-c', script, helper, real.key, real.archive, f.output]);
  assert.deepEqual(readFileSync(f.output), real.payload); rmSync(f.output);
  const corrupt = Buffer.from(real.bytes); corrupt[45] ^= 1;
  writeFileSync(real.archive, corrupt); writeFileSync(real.key, real.keyValue + '\n');
  const result = spawnSync(python, ['-I', helper, 'decrypt', '--key', real.key, '--input', real.archive, '--output', f.output], { encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.equal(existsSync(f.output), false);
});


test('Linux production encrypt and decrypt share normalized key snapshot', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); const plain = join(f.root, 'plain');
  const payload = Buffer.alloc(1024 * 1024 + 31, 91); writeFileSync(plain, payload);
  for (const ending of ['\n', '\r\n', '']) {
    writeFileSync(f.key, 'A'.repeat(64) + ending);
    const encrypted = run(f, 'encrypt', plain, f.archive); assert.equal(encrypted.status, 0, encrypted.stderr);
    assert.equal(run(f, 'verify').status, 0);
    const decrypted = run(f, 'decrypt'); assert.equal(decrypted.status, 0, decrypted.stderr);
    assert.deepEqual(readFileSync(f.output), payload); rmSync(f.output); rmSync(f.archive);
  }
  const driver = join(f.root, 'encrypt-snapshot.py');
  writeFileSync(driver,     'import importlib.util, pathlib, subprocess\n' +
    'spec=importlib.util.spec_from_file_location("backup", ' + JSON.stringify(helper) + '); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)\n' +
    'original=subprocess.run\n' +
    'def replaced(*args, **kwargs):\n' +
    '    pathlib.Path(' + JSON.stringify(f.key) + ').write_text("B"*64)\n' +
    '    return original(*args, **kwargs)\n' +
    'module.subprocess.run=replaced\n' +
    'module.envelope("encrypt", ' + JSON.stringify(f.key) + ', ' + JSON.stringify(plain) + ', ' + JSON.stringify(f.archive) + ')\n');
  const raced = checked(python, ['-I', driver]); assert.equal(raced.status, 0);
  writeFileSync(f.key, 'A'.repeat(64)); assert.equal(run(f, 'verify').status, 0);
  assert.equal(run(f, 'decrypt').status, 0); assert.deepEqual(readFileSync(f.output), payload);
});


test('key-init creates a private independent secret and never replaces an existing key', t => {
  const f = fixture(t); const fresh = join(f.root, 'fresh-key');
  checked(python, ['-X', 'utf8', '-I', helper, 'key-init', '--key', fresh]);
  const bytes = readFileSync(fresh); assert.match(bytes.toString(), /^[A-Za-z0-9+/]{64}\n$/);
  checked(python, ['-X', 'utf8', '-I', helper, 'key-init', '--key', fresh]);
  assert.deepEqual(readFileSync(fresh), bytes);
  writeFileSync(fresh, 'invalid');
  const result = spawnSync(python, ['-X', 'utf8', '-I', helper, 'key-init', '--key', fresh], { encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.equal(readFileSync(fresh, 'utf8'), 'invalid');
});

test('Linux key paths reject unsafe directories and owners while preserving fixed release aliases', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); const shared = join(f.root, 'shared'); const release = join(f.root, 'release');
  mkdirSync(shared, { mode: 0o700 }); mkdirSync(release, { mode: 0o700 });
  const target = join(shared, '.backup-key'); const alias = join(release, '.backup-key');
  symlinkSync(target, alias);
  checked(python, ['-I', helper, 'key-init', '--key', alias]);
  const original = readFileSync(target);
  checked(python, ['-I', helper, 'key-init', '--key', alias]); assert.deepEqual(readFileSync(target), original);
  const permissions = checked(python, ['-I', '-c', 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777))', target]);
  assert.equal(permissions.stdout.trim(), '0o600');
  for (const dir of [shared, release]) {
    chmodSync(dir, 0o777);
    const result = spawnSync(python, ['-I', helper, 'key-init', '--key', alias], { encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.deepEqual(readFileSync(target), original); chmodSync(dir, 0o700);
  }
  const linked = join(shared, 'hardlink'); linkSync(target, linked);
  assert.notEqual(spawnSync(python, ['-I', helper, 'key-init', '--key', alias]).status, 0); rmSync(linked);
  chmodSync(target, 0o644);
  assert.notEqual(spawnSync(python, ['-I', helper, 'key-init', '--key', alias]).status, 0); chmodSync(target, 0o600);
  checked(python, ['-I', '-c',
    'import importlib.util,sys,types\ns=importlib.util.spec_from_file_location("m",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\noriginal=m.os.fstat\ndef wrong(fd):\n x=original(fd); fields={k:getattr(x,k) for k in dir(x) if k.startswith("st_")};fields["st_uid"]=424242;return types.SimpleNamespace(**fields)\nm.os.fstat=wrong\ntry: m.secret(sys.argv[2])\nexcept ValueError: pass\nelse: raise AssertionError("foreign owner accepted")\n', helper, target]);
});

test('Linux producer and consumer use anonymous plaintext and propagate failures before publication', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); const captured = join(f.root, 'captured'); const producerMark = join(f.root, 'producer');
  const payload = Buffer.alloc(1024 * 1024 + 27, 71); const input = join(f.root, 'input'); writeFileSync(input, payload);
  const producer = 'import os,sys,pathlib; assert os.fstat(1).st_nlink==0; pathlib.Path(sys.argv[2]).write_text("ran"); sys.stdout.buffer.write(pathlib.Path(sys.argv[1]).read_bytes())';
  checked(python, ['-I', helper, 'encrypt', '--key', f.key, '--output', f.archive, '--producer', python, '-I', '-c', producer, input, producerMark]);
  assert.equal(readFileSync(producerMark, 'utf8'), 'ran');
  const consumer = 'import os,sys,pathlib; assert os.fstat(0).st_nlink==0; pathlib.Path(sys.argv[1]).write_bytes(sys.stdin.buffer.read())';
  const consumeArgs = [python, '-I', '-c', consumer, captured];
  checked(python, ['-I', helper, 'decrypt', '--key', f.key, '--input', f.archive, '--consumer', ...consumeArgs]);
  assert.deepEqual(readFileSync(captured), payload); rmSync(captured);
  const corrupt = readFileSync(f.archive); corrupt[45] ^= 1; writeFileSync(f.archive, corrupt);
  assert.notEqual(spawnSync(python, ['-I', helper, 'decrypt', '--key', f.key, '--input', f.archive, '--consumer', ...consumeArgs]).status, 0);
  assert.equal(existsSync(captured), false); rmSync(f.archive);
  seal(f); // Authentic envelope with an invalid CBC block length must not start the consumer.
  assert.notEqual(spawnSync(python, ['-I', helper, 'decrypt', '--key', f.key, '--input', f.archive, '--consumer', ...consumeArgs]).status, 0);
  assert.equal(existsSync(captured), false); rmSync(f.archive);
  const failedProducer = spawnSync(python, ['-I', helper, 'encrypt', '--key', f.key, '--output', f.archive, '--producer', python, '-I', '-c', 'import sys;sys.stdout.buffer.write(b"partial");sys.exit(7)']);
  assert.notEqual(failedProducer.status, 0); assert.equal(existsSync(f.archive), false);
  checked(python, ['-I', helper, 'encrypt', '--key', f.key, '--output', f.archive, '--producer', python, '-I', '-c', producer, input, producerMark]);
  assert.notEqual(spawnSync(python, ['-I', helper, 'decrypt', '--key', f.key, '--input', f.archive, '--consumer', python, '-I', '-c', 'import sys; sys.exit(9)']).status, 0);
  const legacy = join(f.root, 'legacy.tar.gz'); writeFileSync(legacy, payload);
  checked(python, ['-I', helper, 'snapshot', '--input', legacy, '--allow-legacy', '--consumer', ...consumeArgs]);
  assert.deepEqual(readFileSync(captured), payload); rmSync(captured);
  const symlink = join(f.root, 'legacy-link'); symlinkSync(legacy, symlink);
  const hardlink = join(f.root, 'legacy-hard'); linkSync(legacy, hardlink);
  for (const file of [symlink, legacy, hardlink]) {
    assert.notEqual(spawnSync(python, ['-I', helper, 'snapshot', '--input', file, '--allow-legacy', '--consumer', ...consumeArgs]).status, 0);
    assert.equal(existsSync(captured), false);
  }
});

test('legacy snapshot refuses same-inode mutation before invoking restore consumer', t => {
  const f = fixture(t); const invoked = join(f.root, 'consumer-marker');
  const script = 'import importlib.util,sys,pathlib\ns=importlib.util.spec_from_file_location("m",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\noriginal=m.copy_bytes\ndef race(source,target,count,mac=None):\n original(source,target,count,mac)\n with open(sys.argv[2],"r+b") as f: f.seek(5);f.write(b"X")\nm.copy_bytes=race\nm.envelope("snapshot",None,sys.argv[2],allow_legacy=True,consumer=[sys.executable,"-I","-c","import pathlib,sys;pathlib.Path(sys.argv[1]).touch()",sys.argv[3]])\n';
  const result = spawnSync(python, ['-X', 'utf8', '-I', '-c', script, helper, f.cipher, invoked], { encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /读取期间文件发生变化/); assert.equal(existsSync(invoked), false);
});


test('Linux shell restores the complete authenticated stream after stdin-draining Docker preparation', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); const real = realBackup(f.root, Buffer.alloc(1024 * 1024 + 19, 92));
  const root = join(f.root, 'project'); const bin = join(f.root, 'bin'); mkdirSync(join(root, 'scripts'), { recursive: true }); mkdirSync(bin);
  for (const name of ['docker.sh', 'backup-integrity.py']) cpSync(resolve('scripts', name), join(root, 'scripts', name));
  cpSync(resolve('scripts/lib'), join(root, 'scripts/lib'), { recursive: true });
  writeFileSync(join(root, '.env'), 'AUTH_DOMAIN=sq.example.test\nBUILD_DOMAIN=db.example.test\nAPPGOG_DEPLOYMENT_ROLE=license\n');
  writeFileSync(join(root, 'compose.license.yaml'), 'services: {}\n');
  const captured = join(f.root, 'restored'); const log = join(f.root, 'docker.log');
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\nprintf "%s\n" "$*" >> "$APPGOG_TEST_DOCKER_LOG"\ncase "$*" in\n "compose version"*) echo v2.24.6 ;;\n *"node scripts/docker/restore.js -"*) cat > "$APPGOG_TEST_RESTORE_OUTPUT"; exit "${APPGOG_TEST_RESTORE_STATUS:-0}" ;;\n *"build"*|*"--entrypoint sh"*) cat >/dev/null ;;\nesac\n', { mode: 0o700 });
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH, APPGOG_PROJECT: 'restore-fixture', APPGOG_BACKUP_KEY_FILE: real.key, APPGOG_TEST_DOCKER_LOG: log, APPGOG_TEST_RESTORE_OUTPUT: captured };
  checked('sh', [join(root, 'scripts/docker.sh'), 'restore', real.archive], { env });
  assert.deepEqual(readFileSync(captured), real.payload);
  assert.match(readFileSync(log, 'utf8'), /compose -p restore-fixture -f .*compose\.license\.yaml run .*restore\.js/);
  assert.match(readFileSync(log, 'utf8'), / up /);
  writeFileSync(log, ''); rmSync(captured);
  const failure = spawnSync('sh', [join(root, 'scripts/docker.sh'), 'restore', real.archive], { encoding: 'utf8', env: { ...env, APPGOG_TEST_RESTORE_STATUS: '9' } });
  assert.notEqual(failure.status, 0); assert.doesNotMatch(readFileSync(log, 'utf8'), / up /);
  const internal = spawnSync('sh', [join(root, 'scripts/docker.sh'), 'restore-stream'], { encoding: 'utf8', env });
  assert.notEqual(internal.status, 0); assert.match(internal.stderr, /内部恢复入口不能直接调用/);
});

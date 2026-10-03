import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export const python = process.env.APPGOG_TEST_PYTHON || 'python3';
export const openssl = process.env.APPGOG_TEST_OPENSSL || (process.platform === 'win32' && existsSync('C:/Program Files/Git/usr/bin/openssl.exe') ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl');
export const helper = resolve('scripts/backup-integrity.py');
export function checked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result;
}
export function realBackup(root, payload = Buffer.from('real business data\n'), label = 'real') {
  const keyValue = 'A'.repeat(64);
  const key = join(root, label + '.key');
  const cipher = join(root, label + '.cipher');
  const archive = join(root, label + '.tar.gz.enc');
  writeFileSync(key, keyValue + '\n', { mode: 0o600 });
  checked(openssl, ['enc', '-aes-256-cbc', '-salt', '-pbkdf2', '-iter', '200000', '-pass', 'file:' + key, '-out', cipher], { input: payload });
  checked(python, ['-X', 'utf8', '-I', helper, 'seal', '--key', key, '--input', cipher, '--output', archive]);
  return { key, keyValue, cipher, archive, payload, bytes: readFileSync(archive) };
}
export function decryptBackup(key, cipher) {
  return checked(openssl, ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-pass', 'stdin', '-in', cipher], { encoding: null, input: readFileSync(key, 'utf8').replace(/\r?\n$/, '') + '\n' }).stdout;
}

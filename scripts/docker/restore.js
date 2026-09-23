import { readdirSync, mkdtempSync, createWriteStream, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

export const backupRoots = ['var/data', 'var/keys', 'var/artifacts', 'var/uploads', 'runtime/license', 'runtime/build', 'runtime/worker', 'runtime/caddy-data', 'runtime/caddy-config'];
export function validateEntries(names, listing) {
  for (const name of names) {
    const clean = name.replace(/\/$/, '');
    if (clean.split('/').some(part => part === '..' || part === '.' || part === '') || clean.includes('\\') ||
      !backupRoots.some(root => clean === root || clean.startsWith(`${root}/`))) throw new Error('备份包含非预期路径');
  }
  if (listing.some(line => !/^[d-]/.test(line))) throw new Error('备份不允许符号链接、硬链接或设备文件');
  for (const required of ['runtime/license/identity.json', 'var/keys/ed25519-private.pem', 'var/keys/ed25519-public.pem', 'var/data/appgog.sqlite']) {
    if (!names.includes(required)) throw new Error(`备份缺少 ${required}`);
  }
}
export function restore(archive, root = '/app') {
  const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim().split('\n');
  const listing = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim().split('\n');
  validateEntries(names, listing);
  for (const path of backupRoots) {
    if (readdirSync(join(root, path)).length) throw new Error(`目标 ${path} 非空，禁止覆盖；请在新项目中恢复`);
  }
  execFileSync('tar', ['-xzf', archive, '-C', root, '--no-same-owner', '--keep-old-files', '--delay-directory-restore'], { stdio: 'inherit' });
  console.log('完整备份已恢复；下次初始化将校验签名密钥并使用 .env 中的域名。');
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  let temporary;
  try {
    if (!process.argv[2]) throw new Error('缺少备份路径');
    let archive = process.argv[2];
    if (archive === '-') {
      temporary = mkdtempSync(join(tmpdir(), 'appgog-restore-'));
      archive = join(temporary, 'backup.tar.gz');
      await pipeline(process.stdin, createWriteStream(archive, { mode: 0o600 }));
    }
    restore(archive);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { if (temporary) rmSync(temporary, { recursive: true, force: true }); }
}

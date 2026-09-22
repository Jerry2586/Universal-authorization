import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { invariant } from './errors.js';

export function hashPassword(password) {
  invariant(typeof password === 'string' && password.length >= 12, 'PASSWORD_TOO_SHORT', '管理员密码至少需要 12 个字符');
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$32768$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export function verifyPassword(password, encoded) {
  try {
    const [algorithm, n, r, p, saltPart, hashPart] = encoded.split('$');
    if (algorithm !== 'scrypt') return false;
    const expected = Buffer.from(hashPart, 'base64url');
    const actual = scryptSync(password, Buffer.from(saltPart, 'base64url'), expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

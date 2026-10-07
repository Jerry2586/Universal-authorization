import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { invariant } from './errors.js';

export const ADMIN_PASSWORD_MIN_LENGTH = 6;
export const ADMIN_PASSWORD_MAX_LENGTH = 128;

export function isValidAdminPassword(password) {
  return typeof password === 'string'
    && password.length >= ADMIN_PASSWORD_MIN_LENGTH
    && password.length <= ADMIN_PASSWORD_MAX_LENGTH;
}

export function hashPassword(password) {
  invariant(typeof password === 'string' && password.length >= ADMIN_PASSWORD_MIN_LENGTH, 'PASSWORD_TOO_SHORT', '管理员密码至少需要 6 个字符');
  invariant(password.length <= ADMIN_PASSWORD_MAX_LENGTH, 'PASSWORD_TOO_LONG', '管理员密码最多允许 128 个字符');
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

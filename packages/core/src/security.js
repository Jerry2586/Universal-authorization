import { createHmac, timingSafeEqual } from 'node:crypto';
import { invariant } from './errors.js';

export function hashSecret(secret, pepper) {
  invariant(typeof secret === 'string' && secret.length >= 12, 'SECRET_TOO_SHORT', '凭证格式无效');
  invariant(typeof pepper === 'string' && pepper.length >= 32, 'PEPPER_INVALID', '服务端 KEY_HASH_PEPPER 必须至少 32 个字符', 500);
  return createHmac('sha256', pepper).update(secret, 'utf8').digest('hex');
}

export function secretMatches(secret, expectedHash, pepper) {
  const actual = Buffer.from(hashSecret(secret, pepper), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { invariant } from './errors.js';

function deriveKey(secret) {
  invariant(typeof secret === 'string' && secret.length >= 32, 'ENCRYPTION_KEY_INVALID', 'DELIVERY_ENCRYPTION_KEY 必须至少 32 个字符', 500);
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function sealSecret(plaintext, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function openSecret(envelope, secret) {
  const [ivPart, tagPart, contentPart] = String(envelope).split('.');
  invariant(ivPart && tagPart && contentPart, 'ENVELOPE_INVALID', '加密凭证格式无效', 500);
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(contentPart, 'base64url')), decipher.final()]).toString('utf8');
}

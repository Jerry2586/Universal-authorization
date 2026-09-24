import { randomBytes, randomUUID } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomText(length) {
  const bytes = randomBytes(length);
  let output = '';
  for (let index = 0; index < length; index += 1) {
    output += ALPHABET[bytes[index] % ALPHABET.length];
  }
  return output;
}

export function newId(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

export function newLicenseKey(productCode = 'APPGOG') {
  return `${productCode.toUpperCase()}-${randomText(4)}-${randomText(4)}-${randomText(4)}-${randomText(4)}`;
}

export function newBuildTicket() {
  return `BT_${randomBytes(32).toString('base64url')}`;
}

export function newPackageSecret() {
  return `PKG_${randomBytes(32).toString('base64url')}`;
}

export function newInstallKey() {
  return `INS-${randomText(4)}-${randomText(4)}-${randomText(4)}`;
}

export function newInstallReceiptSecret() {
  return `IRC_${randomBytes(32).toString('base64url')}`;
}

export function newRefreshSecret() {
  return `RFS_${randomBytes(32).toString('base64url')}`;
}

export function newInstallationChallengeNonce() {
  return randomBytes(32).toString('base64url');
}

export function newProductMigrationGrant() {
  return `PMG_${randomBytes(36).toString('base64url')}`;
}

export function newSessionToken() {
  return `SES_${randomBytes(32).toString('base64url')}`;
}

export function newCsrfToken() {
  return randomBytes(24).toString('base64url');
}

export function newNodeCredential(role = 'node') {
  const prefix = role === 'worker' ? 'WRK' : 'BLD';
  return `${prefix}_${randomBytes(36).toString('base64url')}`;
}

export function keyPrefix(key) {
  return key.slice(0, Math.min(12, key.length));
}

import { generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { base64urlEncode } from '../../core/src/encoding.js';
import { installationChallengeMessage, installationIdFromPublicKey } from '../../core/src/installation-proof.js';

export function ensureInstallationIdentity({ directory }) {
  const root = resolve(directory);
  const privatePath = join(root, 'installation-private.pem');
  const publicPath = join(root, 'installation-public.pem');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let privateKeyPem;
  let publicKeyPem;
  try {
    privateKeyPem = readFileSync(privatePath, 'utf8');
    publicKeyPem = readFileSync(publicPath, 'utf8');
  } catch {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
    writeFileSync(privatePath, privateKeyPem, { mode: 0o600, flag: 'wx' });
    writeFileSync(publicPath, publicKeyPem, { mode: 0o644, flag: 'wx' });
  }
  chmodSync(privatePath, 0o600);
  return {
    installationId: installationIdFromPublicKey(publicKeyPem),
    privateKeyPem,
    publicKeyPem,
    privateKeyPath: privatePath,
    publicKeyPath: publicPath,
  };
}

export function signInstallationChallenge({ challenge, privateKey }) {
  return base64urlEncode(sign(null, installationChallengeMessage(challenge), privateKey));
}

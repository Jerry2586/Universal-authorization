import { createHash, createPublicKey, verify } from 'node:crypto';
import { base64urlDecode, stableJson } from './encoding.js';
import { invariant } from './errors.js';

export function installationFingerprint(publicKey) {
  const key = createPublicKey(publicKey);
  const der = key.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('base64url');
}

export function installationIdFromPublicKey(publicKey) {
  return `ins_${installationFingerprint(publicKey)}`;
}

export function installationContextHash(context = {}) {
  return createHash('sha256').update(stableJson(context)).digest('base64url');
}

export function installationChallengeMessage(challenge) {
  return Buffer.from(stableJson({
    v: 1,
    typ: 'installation-proof',
    challenge_id: challenge.id,
    nonce: challenge.nonce,
    purpose: challenge.purpose,
    context_hash: challenge.context_hash,
    installation_id: challenge.installation_id,
    expires_at: challenge.expires_at,
  }));
}

export function verifyInstallationProof({ challenge, publicKey, signature }) {
  invariant(challenge && publicKey && signature, 'INSTALLATION_PROOF_REQUIRED', '缺少服务器安装身份挑战证明', 401);
  const installationId = installationIdFromPublicKey(publicKey);
  invariant(installationId === challenge.installation_id, 'INSTALLATION_IDENTITY_MISMATCH', '安装公钥与 Installation ID 不匹配', 403);
  let valid = false;
  try {
    valid = verify(null, installationChallengeMessage(challenge), createPublicKey(publicKey), base64urlDecode(signature));
  } catch {
    valid = false;
  }
  invariant(valid, 'INSTALLATION_PROOF_INVALID', '服务器安装身份签名无效', 403);
  return { installationId, fingerprint: installationFingerprint(publicKey) };
}

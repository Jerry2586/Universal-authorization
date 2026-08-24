import { createPublicKey, verify } from 'node:crypto';
import { AppError } from '../../shared/errors/app-error.js';
import { canonicalJson, sha256Hex } from '../../shared/cryptography/canonical-json.js';

export interface ActivationSignatureBody {
  product_code: string;
  license_key: string;
  device_public_key: string;
  device_fingerprint_hash: string;
  device_name?: string;
  platform: string;
  os_version?: string;
  client_version: string;
  server_nonce: string;
  client_nonce: string;
  timestamp: string;
  idempotency_key: string;
}

export interface ActivationSignatureInput {
  body: ActivationSignatureBody;
  deviceKeyId: string;
  signature: string;
}

export interface BoundRequestSignatureInput {
  method: 'POST';
  path: BoundRequestPath;
  productCode: string;
  clientVersion: string;
  timestamp: string;
  clientNonce: string;
  deviceId: string;
  deviceKeyId: string;
  idempotencyKey?: string;
  body: Readonly<Record<string, unknown>>;
  publicKeyPem: string;
  signature: string;
}

export type BoundRequestPath =
  | '/api/v1/licenses/verify'
  | '/api/v1/licenses/refresh'
  | '/api/v1/sessions/heartbeat'
  | '/api/v1/sessions/release'
  | '/api/v1/devices/unbind';

export class Ed25519DeviceSignatureVerifier {
  public verifyActivation(input: ActivationSignatureInput): { publicKeyFingerprint: string; signingPayload: string } {
    const publicKey = parsePublicKey(input.body.device_public_key);
    const signingPayload = activationSigningPayload(input.body, input.deviceKeyId);
    verifySignature(publicKey, input.signature, signingPayload);
    const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
    return { publicKeyFingerprint: sha256Hex(publicKeyDer), signingPayload };
  }

  public verifyBoundRequest(input: BoundRequestSignatureInput): { publicKeyFingerprint: string; signingPayload: string } {
    const publicKey = parsePublicKey(input.publicKeyPem);
    const signingPayload = boundRequestSigningPayload(input);
    verifySignature(publicKey, input.signature, signingPayload);
    const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
    return { publicKeyFingerprint: sha256Hex(publicKeyDer), signingPayload };
  }
}

export function activationSigningPayload(body: ActivationSignatureBody, deviceKeyId: string): string {
  const bodyHash = sha256Hex(canonicalJson(body));
  return [
    'v1', 'POST', '/api/v1/licenses/activate', body.product_code, body.client_version,
    body.timestamp, body.client_nonce, body.server_nonce, body.idempotency_key, deviceKeyId, bodyHash,
  ].join('\n');
}

export function boundRequestSigningPayload(input: Omit<BoundRequestSignatureInput, 'publicKeyPem' | 'signature'>): string {
  const bodyHash = sha256Hex(canonicalJson(input.body));
  return [
    'v1', input.method, input.path, input.productCode, input.clientVersion,
    input.timestamp, input.clientNonce, input.deviceId, input.deviceKeyId,
    input.idempotencyKey ?? '', bodyHash,
  ].join('\n');
}

function parsePublicKey(publicKeyPem: string) {
  let publicKey;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch {
    throw signatureInvalid('设备公钥格式无效');
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') throw signatureInvalid('设备公钥必须使用 Ed25519');
  return publicKey;
}

function verifySignature(publicKey: ReturnType<typeof createPublicKey>, encodedSignature: string, payload: string): void {
  let signature: Buffer;
  try {
    signature = Buffer.from(encodedSignature, 'base64url');
  } catch {
    throw signatureInvalid('设备签名编码无效');
  }
  if (signature.length !== 64) throw signatureInvalid('设备签名长度无效');
  if (!verify(null, Buffer.from(payload, 'utf8'), publicKey, signature)) throw signatureInvalid('设备签名验证失败');
}

function signatureInvalid(message: string): AppError {
  return new AppError({ code: 'SIGNATURE_INVALID', message, statusCode: 401 });
}

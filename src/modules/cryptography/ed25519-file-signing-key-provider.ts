import { createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { AppError } from '../../shared/errors/app-error.js';
import type { PublicSigningKey, SignatureResult, SigningKeyProvider } from './signing-key-provider.js';

export class Ed25519FileSigningKeyProvider implements SigningKeyProvider {
  private readonly privateKey?: KeyObject;
  private readonly publicKey?: PublicSigningKey;

  public constructor(
    private readonly keyId: string,
    privateKeyPemBase64?: string,
  ) {
    if (privateKeyPemBase64 === undefined) return;
    try {
      const pem = Buffer.from(privateKeyPemBase64, 'base64').toString('utf8');
      const privateKey = createPrivateKey(pem);
      if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('not Ed25519');
      const publicKeyObject = createPublicKey(privateKey);
      this.privateKey = privateKey;
      this.publicKey = {
        keyId,
        algorithm: 'Ed25519',
        publicKeyPem: publicKeyObject.export({ type: 'spki', format: 'pem' }).toString(),
        activatedAt: new Date(0),
      };
    } catch {
      throw new AppError({
        code: 'SIGNING_KEY_INVALID',
        message: '服务端 Ed25519 签名私钥格式无效',
        statusCode: 503,
      });
    }
  }

  public async getActiveKey(): Promise<PublicSigningKey> {
    return this.requirePublicKey();
  }

  public async sign(payload: Uint8Array): Promise<SignatureResult> {
    const privateKey = this.requirePrivateKey();
    return {
      keyId: this.keyId,
      algorithm: 'Ed25519',
      signature: sign(null, payload, privateKey),
    };
  }

  public async getVerificationKeys(): Promise<readonly PublicSigningKey[]> {
    return [this.requirePublicKey()];
  }

  private requirePrivateKey(): KeyObject {
    if (this.privateKey === undefined) throw notConfigured();
    return this.privateKey;
  }

  private requirePublicKey(): PublicSigningKey {
    if (this.publicKey === undefined) throw notConfigured();
    return this.publicKey;
  }
}

function notConfigured(): AppError {
  return new AppError({
    code: 'SIGNING_KEY_NOT_CONFIGURED',
    message: '服务端授权签名私钥尚未配置',
    statusCode: 503,
  });
}

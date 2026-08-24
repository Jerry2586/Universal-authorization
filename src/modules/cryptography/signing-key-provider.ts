export type SigningAlgorithm = 'Ed25519';

export interface PublicSigningKey {
  keyId: string;
  algorithm: SigningAlgorithm;
  publicKeyPem: string;
  activatedAt: Date;
  retiresAt?: Date;
}

export interface SignatureResult {
  keyId: string;
  algorithm: SigningAlgorithm;
  signature: Uint8Array;
}

export interface SigningKeyProvider {
  getActiveKey(): Promise<PublicSigningKey>;
  sign(payload: Uint8Array): Promise<SignatureResult>;
  getVerificationKeys(): Promise<readonly PublicSigningKey[]>;
}

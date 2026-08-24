export interface ActivationFeature {
  code: string;
  allowed: boolean;
  limits: Readonly<Record<string, unknown>>;
  expiresAt: Date | null;
}

export interface PersistActivationInput {
  productCode: string;
  keyHash: string;
  devicePublicKey: string;
  devicePublicKeyFingerprint: string;
  deviceFingerprintHash: string;
  deviceName: string | null;
  platform: string;
  osVersion: string | null;
  clientVersion: string;
  deviceKeyId: string;
  sessionId: string;
  tokenJti: string;
  tokenTtlSeconds: number;
  now: Date;
  requestId: string;
  ipAddress: string | null;
}

export interface ActivationGrant {
  tenantId: string;
  productId: string;
  productCode: string;
  licenseId: string;
  licenseType: string;
  licenseStatus: 'ACTIVE';
  licenseExpiresAt: Date | null;
  deviceId: string;
  activationId: string;
  sessionId: string;
  tokenJti: string;
  issuedAt: Date;
  tokenExpiresAt: Date;
  offlineUntil: Date | null;
  repeatedActivation: boolean;
  devicePublicKeyFingerprint: string;
  deviceKeyId: string;
  maxDevices: number;
  maxConcurrentSessions: number;
  features: readonly ActivationFeature[];
}

export interface ActivationRepository {
  activate(input: PersistActivationInput): Promise<ActivationGrant>;
  revokeSession(sessionId: string, now: Date): Promise<void>;
}

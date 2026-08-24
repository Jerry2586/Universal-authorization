export interface RuntimeFeature {
  code: string;
  allowed: boolean;
  limits: Readonly<Record<string, unknown>>;
  expiresAt: Date | null;
}

export interface DeviceRequestIdentityInput {
  tenantId: string;
  productCode: string;
  licenseId: string;
  deviceId: string;
  activationId: string;
}

export interface DeviceRequestIdentity {
  publicKeyPem: string;
  publicKeyFingerprint: string;
  deviceKeyId: string;
}

export interface RuntimeLicenseInput extends DeviceRequestIdentityInput {
  sessionId: string;
  tokenJti: string;
  clientVersion: string;
  now: Date;
  requestId: string;
  ipAddress: string | null;
}

export interface RuntimeLicenseGrant {
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
  sessionStatus: 'VALID' | 'GRACE';
  issuedAt: Date;
  tokenExpiresAt: Date;
  offlineUntil: Date | null;
  devicePublicKeyFingerprint: string;
  deviceKeyId: string;
  maxDevices: number;
  maxConcurrentSessions: number;
  features: readonly RuntimeFeature[];
}

export interface RefreshRuntimeLicenseInput extends RuntimeLicenseInput {
  newSessionId: string;
  newTokenJti: string;
  tokenTtlSeconds: number;
}

export interface HeartbeatRuntimeLicenseInput extends RuntimeLicenseInput {
  sequence: number;
}

export interface SessionReleaseRuntimeResult {
  tenantId: string;
  productId: string;
  licenseId: string;
  deviceId: string;
  activationId: string;
  sessionId: string;
  releasedAt: Date;
}

export interface DeviceUnbindRuntimeResult {
  tenantId: string;
  productId: string;
  licenseId: string;
  deviceId: string;
  activationId: string;
  unboundAt: Date;
  revokedSessionIds: readonly string[];
}

export interface LicenseRuntimeRepository {
  loadDeviceRequestIdentity(input: DeviceRequestIdentityInput): Promise<DeviceRequestIdentity>;
  verify(input: RuntimeLicenseInput): Promise<RuntimeLicenseGrant>;
  refresh(input: RefreshRuntimeLicenseInput): Promise<RuntimeLicenseGrant>;
  heartbeat(input: HeartbeatRuntimeLicenseInput): Promise<RuntimeLicenseGrant>;
  releaseSession(input: RuntimeLicenseInput): Promise<SessionReleaseRuntimeResult>;
  unbindDevice(input: RuntimeLicenseInput): Promise<DeviceUnbindRuntimeResult>;
  revokeSession(sessionId: string, now: Date): Promise<void>;
}

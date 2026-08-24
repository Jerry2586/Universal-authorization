import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { CompactTokenIssuer } from '../src/modules/cryptography/compact-token-issuer.js';
import { Ed25519FileSigningKeyProvider } from '../src/modules/cryptography/ed25519-file-signing-key-provider.js';
import { boundRequestSigningPayload, type BoundRequestPath } from '../src/modules/cryptography/ed25519-device-signature-verifier.js';
import type {
  DeviceRequestIdentityInput,
  DeviceUnbindRuntimeResult,
  HeartbeatRuntimeLicenseInput,
  LicenseRuntimeRepository,
  RefreshRuntimeLicenseInput,
  RuntimeLicenseGrant,
  RuntimeLicenseInput,
  SessionReleaseRuntimeResult,
} from '../src/modules/verification/license-runtime.repository.js';

export const runtimeIds = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  productId: '22222222-2222-4222-8222-222222222222',
  licenseId: '33333333-3333-4333-8333-333333333333',
  deviceId: '44444444-4444-4444-8444-444444444444',
  activationId: '55555555-5555-4555-8555-555555555555',
  sessionId: '66666666-6666-4666-8666-666666666666',
  tokenJti: '77777777-7777-4777-8777-777777777777',
};

export class FakeLicenseRuntimeRepository implements LicenseRuntimeRepository {
  public verifyCalls: RuntimeLicenseInput[] = [];
  public refreshCalls: RefreshRuntimeLicenseInput[] = [];
  public revokedSessions: string[] = [];
  public heartbeatCalls: HeartbeatRuntimeLicenseInput[] = [];
  public releaseCalls: RuntimeLicenseInput[] = [];
  public unbindCalls: RuntimeLicenseInput[] = [];
  public grant: RuntimeLicenseGrant;

  public constructor(
    public readonly devicePublicKeyPem: string,
    public readonly devicePublicKeyFingerprint: string,
    public readonly deviceKeyId = 'device-key-v1',
    now = new Date('2026-08-24T12:00:00.000Z'),
  ) {
    this.grant = {
      tenantId: runtimeIds.tenantId,
      productId: runtimeIds.productId,
      productCode: 'demo-product',
      licenseId: runtimeIds.licenseId,
      licenseType: 'PERPETUAL',
      licenseStatus: 'ACTIVE',
      licenseExpiresAt: null,
      deviceId: runtimeIds.deviceId,
      activationId: runtimeIds.activationId,
      sessionId: runtimeIds.sessionId,
      tokenJti: runtimeIds.tokenJti,
      sessionStatus: 'VALID',
      issuedAt: now,
      tokenExpiresAt: new Date(now.getTime() + 900_000),
      offlineUntil: new Date(now.getTime() + 86_400_000),
      devicePublicKeyFingerprint,
      deviceKeyId,
      maxDevices: 2,
      maxConcurrentSessions: 2,
      features: [{ code: 'api.access', allowed: true, limits: { rpm: 60 }, expiresAt: null }],
    };
  }

  public async loadDeviceRequestIdentity(_input: DeviceRequestIdentityInput) {
    return {
      publicKeyPem: this.devicePublicKeyPem,
      publicKeyFingerprint: this.devicePublicKeyFingerprint,
      deviceKeyId: this.deviceKeyId,
    };
  }

  public async verify(input: RuntimeLicenseInput): Promise<RuntimeLicenseGrant> {
    this.verifyCalls.push(input);
    return this.grant;
  }

  public async refresh(input: RefreshRuntimeLicenseInput): Promise<RuntimeLicenseGrant> {
    this.refreshCalls.push(input);
    return {
      ...this.grant,
      sessionId: input.newSessionId,
      tokenJti: input.newTokenJti,
      sessionStatus: 'VALID',
      issuedAt: input.now,
      tokenExpiresAt: new Date(input.now.getTime() + input.tokenTtlSeconds * 1_000),
    };
  }

  public async heartbeat(input: HeartbeatRuntimeLicenseInput): Promise<RuntimeLicenseGrant> {
    this.heartbeatCalls.push(input);
    return this.grant;
  }

  public async releaseSession(input: RuntimeLicenseInput): Promise<SessionReleaseRuntimeResult> {
    this.releaseCalls.push(input);
    return {
      tenantId: this.grant.tenantId, productId: this.grant.productId, licenseId: this.grant.licenseId,
      deviceId: this.grant.deviceId, activationId: this.grant.activationId, sessionId: this.grant.sessionId, releasedAt: input.now,
    };
  }

  public async unbindDevice(input: RuntimeLicenseInput): Promise<DeviceUnbindRuntimeResult> {
    this.unbindCalls.push(input);
    return {
      tenantId: this.grant.tenantId, productId: this.grant.productId, licenseId: this.grant.licenseId,
      deviceId: this.grant.deviceId, activationId: this.grant.activationId, unboundAt: input.now,
      revokedSessionIds: [this.grant.sessionId],
    };
  }

  public async revokeSession(sessionId: string): Promise<void> {
    this.revokedSessions.push(sessionId);
  }
}

export async function createRuntimeCrypto(now = new Date('2026-08-24T12:00:00.000Z'), tokenExpiresAt = new Date('2026-08-24T12:15:00.000Z')) {
  const devicePair = generateKeyPairSync('ed25519');
  const serverPair = generateKeyPairSync('ed25519');
  const devicePublicKeyPem = devicePair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const devicePublicKeyFingerprint = (await import('../src/shared/cryptography/canonical-json.js')).sha256Hex(
    devicePair.publicKey.export({ type: 'spki', format: 'der' }),
  );
  const serverPrivatePemBase64 = Buffer.from(serverPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()).toString('base64');
  const provider = new Ed25519FileSigningKeyProvider('test-signing-v1', serverPrivatePemBase64);
  const issuer = new CompactTokenIssuer(provider);
  const artifacts = await issuer.issue({
    issuer: 'universal-license-server',
    tenantId: runtimeIds.tenantId,
    productCode: 'demo-product',
    licenseId: runtimeIds.licenseId,
    deviceId: runtimeIds.deviceId,
    activationId: runtimeIds.activationId,
    sessionId: runtimeIds.sessionId,
    tokenJti: runtimeIds.tokenJti,
    licenseType: 'PERPETUAL',
    licenseStatus: 'ACTIVE',
    licenseExpiresAt: null,
    issuedAt: now,
    tokenExpiresAt,
    offlineUntil: new Date(tokenExpiresAt.getTime() + 86_400_000),
    certificateExpiresAt: new Date(now.getTime() + 2_592_000_000),
    devicePublicKeyFingerprint,
    deviceKeyId: 'device-key-v1',
    features: [{ code: 'api.access', allowed: true, limits: { rpm: 60 }, expires_at: null }],
    maxDevices: 2,
    maxConcurrentSessions: 2,
  });
  return { devicePair, serverPair, provider, issuer, artifacts, devicePublicKeyPem, devicePublicKeyFingerprint };
}

export function makeVerifyBody(artifacts: { deviceCertificate: string; licenseToken: string }, timestamp: string, nonce = 'verify-client-nonce-123456') {
  return {
    device_certificate: artifacts.deviceCertificate,
    license_token: artifacts.licenseToken,
    client_version: '1.2.0',
    timestamp,
    client_nonce: nonce,
  };
}

export function makeRefreshBody(artifacts: { deviceCertificate: string; licenseToken: string }, timestamp: string, nonce = 'refresh-client-nonce-123456', idempotencyKey = 'refresh-idempotency-123456') {
  return {
    ...makeVerifyBody(artifacts, timestamp, nonce),
    idempotency_key: idempotencyKey,
  };
}

export function signRuntimeRequest(input: {
  path: BoundRequestPath;
  body: Readonly<Record<string, unknown>>;
  privateKey: KeyObject;
  idempotencyKey?: string;
}): string {
  const body = input.body as { client_version: string; timestamp: string; client_nonce: string };
  const payload = boundRequestSigningPayload({
    method: 'POST',
    path: input.path,
    productCode: 'demo-product',
    clientVersion: body.client_version,
    timestamp: body.timestamp,
    clientNonce: body.client_nonce,
    deviceId: runtimeIds.deviceId,
    deviceKeyId: 'device-key-v1',
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    body: input.body,
  });
  return sign(null, Buffer.from(payload), input.privateKey).toString('base64url');
}

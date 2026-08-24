import type { SigningKeyProvider } from './signing-key-provider.js';
import { canonicalJson } from '../../shared/cryptography/canonical-json.js';

export interface LicenseTokenInput {
  issuer: string;
  tenantId: string;
  productCode: string;
  licenseId: string;
  deviceId: string;
  activationId: string;
  sessionId: string;
  tokenJti: string;
  licenseType: string;
  licenseStatus: string;
  licenseExpiresAt: Date | null;
  issuedAt: Date;
  tokenExpiresAt: Date;
  offlineUntil: Date | null;
  features: readonly Readonly<Record<string, unknown>>[];
  maxDevices: number;
  maxConcurrentSessions: number;
}

export interface SignedArtifactsInput extends LicenseTokenInput {
  certificateExpiresAt: Date;
  devicePublicKeyFingerprint: string;
  deviceKeyId: string;
}

export interface SignedArtifacts {
  signingKeyId: string;
  licenseToken: string;
  deviceCertificate: string;
}

export interface SignedLicenseToken {
  signingKeyId: string;
  licenseToken: string;
}

export class CompactTokenIssuer {
  public constructor(private readonly provider: SigningKeyProvider) {}

  public async ensureReady(): Promise<void> {
    await this.provider.getActiveKey();
  }

  public async issue(input: SignedArtifactsInput): Promise<SignedArtifacts> {
    const key = await this.provider.getActiveKey();
    const licenseToken = await this.signLicenseToken(input, key.keyId);
    const deviceCertificate = await this.signCompact('UDC+JWT', {
      ...commonClaims(input, key.keyId),
      sub: input.deviceId,
      exp: epoch(input.certificateExpiresAt),
      device_public_key_fingerprint: input.devicePublicKeyFingerprint,
      device_key_id: input.deviceKeyId,
    }, key.keyId);
    return { signingKeyId: key.keyId, licenseToken, deviceCertificate };
  }

  public async issueLicenseToken(input: LicenseTokenInput): Promise<SignedLicenseToken> {
    const key = await this.provider.getActiveKey();
    return { signingKeyId: key.keyId, licenseToken: await this.signLicenseToken(input, key.keyId) };
  }

  private async signLicenseToken(input: LicenseTokenInput, keyId: string): Promise<string> {
    return this.signCompact('ULT+JWT', {
      ...commonClaims(input, keyId),
      sub: input.licenseId,
      session_id: input.sessionId,
      license_type: input.licenseType,
      license_status: input.licenseStatus,
      license_expires_at: input.licenseExpiresAt?.toISOString() ?? null,
      features: input.features,
      usage_limits: {
        max_devices: input.maxDevices,
        max_concurrent_sessions: input.maxConcurrentSessions,
      },
      exp: epoch(input.tokenExpiresAt),
      offline_until: input.offlineUntil?.toISOString() ?? null,
      jti: input.tokenJti,
    }, keyId);
  }

  private async signCompact(type: string, claims: Readonly<Record<string, unknown>>, keyId: string): Promise<string> {
    const header = encode({ alg: 'EdDSA', kid: keyId, typ: type });
    const payload = encode(claims);
    const signingInput = `${header}.${payload}`;
    const result = await this.provider.sign(Buffer.from(signingInput, 'utf8'));
    if (result.keyId !== keyId || result.algorithm !== 'Ed25519') throw new Error('Signing provider changed active key during issuance');
    return `${signingInput}.${Buffer.from(result.signature).toString('base64url')}`;
  }
}

function commonClaims(input: LicenseTokenInput, keyId: string): Readonly<Record<string, unknown>> {
  return {
    iss: input.issuer,
    aud: input.productCode,
    tenant_id: input.tenantId,
    license_id: input.licenseId,
    device_id: input.deviceId,
    activation_id: input.activationId,
    iat: epoch(input.issuedAt),
    nbf: epoch(input.issuedAt),
    signing_key_id: keyId,
    protocol_version: 'v1',
  };
}

function encode(value: unknown): string {
  return Buffer.from(canonicalJson(value), 'utf8').toString('base64url');
}

function epoch(value: Date): number {
  return Math.floor(value.getTime() / 1_000);
}

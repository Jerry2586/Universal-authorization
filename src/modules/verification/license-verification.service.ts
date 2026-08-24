import type { AuthenticatedDeviceRequest, BoundLicenseRequestInput, DeviceRequestAuthenticator } from './device-request-authenticator.js';
import type { LicenseRuntimeRepository, RuntimeLicenseGrant } from './license-runtime.repository.js';

export interface VerifyLicenseInput extends Omit<BoundLicenseRequestInput, 'path'> {
  requestId: string;
  ipAddress: string | null;
}

export interface LicenseVerificationResponseData {
  valid: true;
  license_id: string;
  device_id: string;
  activation_id: string;
  session_id: string;
  license_status: 'ACTIVE';
  session_status: 'VALID' | 'GRACE';
  verified_at: string;
  expires_at: string;
  license_expires_at: string | null;
  offline_until: string | null;
  should_refresh: boolean;
  refresh_after_seconds: number;
  features: readonly {
    code: string;
    allowed: boolean;
    limits: Readonly<Record<string, unknown>>;
    expires_at: string | null;
  }[];
}

export class LicenseVerificationService {
  public constructor(
    private readonly authenticator: DeviceRequestAuthenticator,
    private readonly repository: LicenseRuntimeRepository,
    private readonly refreshAfterSeconds: number,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async verify(input: VerifyLicenseInput): Promise<LicenseVerificationResponseData> {
    const authenticated = await this.authenticator.authenticate({ ...this.boundInput(input), path: '/api/v1/licenses/verify' });
    await this.authenticator.assertNotReplayed(authenticated);
    const now = this.clock();
    const grant = await this.repository.verify(this.repositoryInput(authenticated, input, now));
    return this.response(grant, authenticated, now);
  }

  private boundInput(input: VerifyLicenseInput): Omit<BoundLicenseRequestInput, 'path'> {
    return {
      productCode: input.productCode,
      clientVersion: input.clientVersion,
      timestamp: input.timestamp,
      clientNonce: input.clientNonce,
      deviceId: input.deviceId,
      deviceKeyId: input.deviceKeyId,
      signature: input.signature,
      body: input.body,
      deviceCertificate: input.deviceCertificate,
      licenseToken: input.licenseToken,
    };
  }

  private repositoryInput(authenticated: AuthenticatedDeviceRequest, input: VerifyLicenseInput, now: Date) {
    const credential = authenticated.deviceCredential;
    const token = authenticated.licenseToken;
    return {
      tenantId: credential.tenant_id,
      productCode: input.productCode,
      licenseId: credential.license_id,
      deviceId: credential.device_id,
      activationId: credential.activation_id,
      sessionId: token.session_id,
      tokenJti: token.jti,
      clientVersion: input.clientVersion,
      now,
      requestId: input.requestId,
      ipAddress: input.ipAddress,
    };
  }

  private response(grant: RuntimeLicenseGrant, authenticated: AuthenticatedDeviceRequest, now: Date): LicenseVerificationResponseData {
    const shouldRefresh = now.getTime() >= (authenticated.licenseToken.iat + this.refreshAfterSeconds) * 1_000;
    return {
      valid: true,
      license_id: grant.licenseId,
      device_id: grant.deviceId,
      activation_id: grant.activationId,
      session_id: grant.sessionId,
      license_status: grant.licenseStatus,
      session_status: grant.sessionStatus,
      verified_at: now.toISOString(),
      expires_at: grant.tokenExpiresAt.toISOString(),
      license_expires_at: grant.licenseExpiresAt?.toISOString() ?? null,
      offline_until: grant.offlineUntil?.toISOString() ?? null,
      should_refresh: shouldRefresh,
      refresh_after_seconds: this.refreshAfterSeconds,
      features: grant.features.map((feature) => ({
        code: feature.code,
        allowed: feature.allowed,
        limits: feature.limits,
        expires_at: feature.expiresAt?.toISOString() ?? null,
      })),
    };
  }
}

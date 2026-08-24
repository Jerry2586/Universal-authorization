import type { BoundLicenseRequestInput, DeviceRequestAuthenticator } from '../verification/device-request-authenticator.js';
import type { LicenseRuntimeRepository } from '../verification/license-runtime.repository.js';
import type { OnlineSessionStore } from './online-session.store.js';

export interface SessionHeartbeatInput extends Omit<BoundLicenseRequestInput, 'path'> {
  sequence: number;
  requestId: string;
  ipAddress: string | null;
}

export interface SessionHeartbeatResponseData {
  online: true;
  license_id: string;
  device_id: string;
  activation_id: string;
  session_id: string;
  session_status: 'VALID' | 'GRACE';
  heartbeat_at: string;
  next_heartbeat_at: string;
  online_ttl_seconds: number;
  should_refresh: boolean;
  features: readonly {
    code: string;
    allowed: boolean;
    limits: Readonly<Record<string, unknown>>;
    expires_at: string | null;
  }[];
}

export interface SessionHeartbeatServiceOptions {
  heartbeatIntervalSeconds: number;
  onlineTtlSeconds: number;
  refreshAfterSeconds: number;
}

export class SessionHeartbeatService {
  public constructor(
    private readonly authenticator: DeviceRequestAuthenticator,
    private readonly repository: LicenseRuntimeRepository,
    private readonly onlineStore: OnlineSessionStore,
    private readonly options: SessionHeartbeatServiceOptions,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async heartbeat(input: SessionHeartbeatInput): Promise<SessionHeartbeatResponseData> {
    const authenticated = await this.authenticator.authenticate({ ...this.boundInput(input), path: '/api/v1/sessions/heartbeat' });
    await this.authenticator.assertNotReplayed(authenticated);
    const now = this.clock();
    const credential = authenticated.deviceCredential;
    const token = authenticated.licenseToken;
    const grant = await this.repository.heartbeat({
      tenantId: credential.tenant_id,
      productCode: input.productCode,
      licenseId: credential.license_id,
      deviceId: credential.device_id,
      activationId: credential.activation_id,
      sessionId: token.session_id,
      tokenJti: token.jti,
      clientVersion: input.clientVersion,
      sequence: input.sequence,
      now,
      requestId: input.requestId,
      ipAddress: input.ipAddress,
    });
    await this.onlineStore.markOnline({
      sessionId: grant.sessionId,
      licenseId: grant.licenseId,
      deviceId: grant.deviceId,
      activationId: grant.activationId,
      lastHeartbeatAt: now,
      sequence: input.sequence,
    }, this.options.onlineTtlSeconds);
    return {
      online: true,
      license_id: grant.licenseId,
      device_id: grant.deviceId,
      activation_id: grant.activationId,
      session_id: grant.sessionId,
      session_status: grant.sessionStatus,
      heartbeat_at: now.toISOString(),
      next_heartbeat_at: new Date(now.getTime() + this.options.heartbeatIntervalSeconds * 1_000).toISOString(),
      online_ttl_seconds: this.options.onlineTtlSeconds,
      should_refresh: now.getTime() >= (token.iat + this.options.refreshAfterSeconds) * 1_000,
      features: grant.features.map((feature) => ({
        code: feature.code,
        allowed: feature.allowed,
        limits: feature.limits,
        expires_at: feature.expiresAt?.toISOString() ?? null,
      })),
    };
  }

  private boundInput(input: SessionHeartbeatInput): Omit<BoundLicenseRequestInput, 'path'> {
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
}

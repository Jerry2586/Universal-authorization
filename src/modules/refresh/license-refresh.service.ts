import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors/app-error.js';
import type { Clock } from '../challenges/challenge.service.js';
import type { CompactTokenIssuer } from '../cryptography/compact-token-issuer.js';
import type { BoundLicenseRequestInput, DeviceRequestAuthenticator } from '../verification/device-request-authenticator.js';
import type { LicenseRuntimeRepository } from '../verification/license-runtime.repository.js';
import type { LicenseRefreshIdempotencyStore } from './license-refresh-idempotency.store.js';

export interface RefreshLicenseInput extends Omit<BoundLicenseRequestInput, 'path'> {
  idempotencyKey: string;
  requestId: string;
  ipAddress: string | null;
}

export interface LicenseRefreshResponseData {
  license_id: string;
  device_id: string;
  activation_id: string;
  previous_session_id: string;
  session_id: string;
  license_status: 'ACTIVE';
  session_status: 'VALID';
  issued_at: string;
  expires_at: string;
  license_expires_at: string | null;
  offline_until: string | null;
  heartbeat_interval_seconds: number;
  refresh_after_seconds: number;
  features: readonly {
    code: string;
    allowed: boolean;
    limits: Readonly<Record<string, unknown>>;
    expires_at: string | null;
  }[];
  license_token: string;
  signing_key_id: string;
}

export interface LicenseRefreshServiceOptions {
  tokenTtlSeconds: number;
  idempotencyTtlSeconds: number;
  heartbeatIntervalSeconds: number;
  refreshAfterSeconds: number;
  issuer: string;
}

export class LicenseRefreshService {
  public constructor(
    private readonly authenticator: DeviceRequestAuthenticator,
    private readonly repository: LicenseRuntimeRepository,
    private readonly idempotency: LicenseRefreshIdempotencyStore,
    private readonly tokenIssuer: CompactTokenIssuer,
    private readonly options: LicenseRefreshServiceOptions,
    private readonly clock: Clock = () => new Date(),
  ) {}

  public async refresh(input: RefreshLicenseInput): Promise<LicenseRefreshResponseData> {
    const authenticated = await this.authenticator.authenticate({
      productCode: input.productCode,
      clientVersion: input.clientVersion,
      timestamp: input.timestamp,
      clientNonce: input.clientNonce,
      deviceId: input.deviceId,
      deviceKeyId: input.deviceKeyId,
      idempotencyKey: input.idempotencyKey,
      signature: input.signature,
      body: input.body,
      deviceCertificate: input.deviceCertificate,
      licenseToken: input.licenseToken,
      path: '/api/v1/licenses/refresh',
    });
    const now = this.clock();
    const claim = await this.idempotency.claim({
      key: input.idempotencyKey,
      requestHash: authenticated.requestHash,
      now,
      expiresAt: new Date(now.getTime() + this.options.idempotencyTtlSeconds * 1_000),
    });
    if (claim.kind === 'COMPLETED') return claim.response;
    if (claim.kind === 'CONFLICT') throw new AppError({ code: 'IDEMPOTENCY_CONFLICT', message: '同一个幂等键不能用于不同的刷新请求', statusCode: 409 });
    if (claim.kind === 'PROCESSING') throw new AppError({ code: 'REQUEST_IN_PROGRESS', message: '相同刷新请求正在处理中', statusCode: 409, retryable: true });

    let newSessionId: string | undefined;
    try {
      await this.authenticator.assertNotReplayed(authenticated);
      await this.tokenIssuer.ensureReady();
      newSessionId = randomUUID();
      const newTokenJti = randomUUID();
      const credential = authenticated.deviceCredential;
      const oldToken = authenticated.licenseToken;
      const grant = await this.repository.refresh({
        tenantId: credential.tenant_id,
        productCode: input.productCode,
        licenseId: credential.license_id,
        deviceId: credential.device_id,
        activationId: credential.activation_id,
        sessionId: oldToken.session_id,
        tokenJti: oldToken.jti,
        clientVersion: input.clientVersion,
        now,
        requestId: input.requestId,
        ipAddress: input.ipAddress,
        newSessionId,
        newTokenJti,
        tokenTtlSeconds: this.options.tokenTtlSeconds,
      });
      const signed = await this.tokenIssuer.issueLicenseToken({
        issuer: this.options.issuer,
        tenantId: grant.tenantId,
        productCode: grant.productCode,
        licenseId: grant.licenseId,
        deviceId: grant.deviceId,
        activationId: grant.activationId,
        sessionId: grant.sessionId,
        tokenJti: grant.tokenJti,
        licenseType: grant.licenseType,
        licenseStatus: grant.licenseStatus,
        licenseExpiresAt: grant.licenseExpiresAt,
        issuedAt: grant.issuedAt,
        tokenExpiresAt: grant.tokenExpiresAt,
        offlineUntil: grant.offlineUntil,
        features: grant.features.map((feature) => ({
          code: feature.code, allowed: feature.allowed, limits: feature.limits,
          expires_at: feature.expiresAt?.toISOString() ?? null,
        })),
        maxDevices: grant.maxDevices,
        maxConcurrentSessions: grant.maxConcurrentSessions,
      });
      const response: LicenseRefreshResponseData = {
        license_id: grant.licenseId,
        device_id: grant.deviceId,
        activation_id: grant.activationId,
        previous_session_id: oldToken.session_id,
        session_id: grant.sessionId,
        license_status: grant.licenseStatus,
        session_status: 'VALID',
        issued_at: grant.issuedAt.toISOString(),
        expires_at: grant.tokenExpiresAt.toISOString(),
        license_expires_at: grant.licenseExpiresAt?.toISOString() ?? null,
        offline_until: grant.offlineUntil?.toISOString() ?? null,
        heartbeat_interval_seconds: this.options.heartbeatIntervalSeconds,
        refresh_after_seconds: Math.min(this.options.refreshAfterSeconds, this.options.tokenTtlSeconds),
        features: grant.features.map((feature) => ({
          code: feature.code, allowed: feature.allowed, limits: feature.limits,
          expires_at: feature.expiresAt?.toISOString() ?? null,
        })),
        license_token: signed.licenseToken,
        signing_key_id: signed.signingKeyId,
      };
      await this.idempotency.complete({ key: input.idempotencyKey, requestHash: authenticated.requestHash, response, now });
      return response;
    } catch (error) {
      if (newSessionId !== undefined) await this.repository.revokeSession(newSessionId, now).catch(() => undefined);
      await this.idempotency.release(input.idempotencyKey, authenticated.requestHash).catch(() => undefined);
      throw error;
    }
  }
}

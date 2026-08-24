import { AppError } from '../../shared/errors/app-error.js';
import type { Clock } from '../challenges/challenge.service.js';
import type { SessionActionIdempotencyStore } from '../session-actions/session-action-idempotency.store.js';
import type { BoundLicenseRequestInput, DeviceRequestAuthenticator } from '../verification/device-request-authenticator.js';
import type { LicenseRuntimeRepository } from '../verification/license-runtime.repository.js';
import type { OnlineSessionStore } from './online-session.store.js';

export interface SessionReleaseInput extends Omit<BoundLicenseRequestInput, 'path'> {
  idempotencyKey: string;
  requestId: string;
  ipAddress: string | null;
}

export interface SessionReleaseResponseData {
  released: true;
  license_id: string;
  device_id: string;
  activation_id: string;
  session_id: string;
  session_status: 'REVOKED';
  released_at: string;
}

export class SessionReleaseService {
  public constructor(
    private readonly authenticator: DeviceRequestAuthenticator,
    private readonly repository: LicenseRuntimeRepository,
    private readonly idempotency: SessionActionIdempotencyStore,
    private readonly onlineStore: OnlineSessionStore,
    private readonly idempotencyTtlSeconds: number,
    private readonly clock: Clock = () => new Date(),
  ) {}

  public async release(input: SessionReleaseInput): Promise<SessionReleaseResponseData> {
    const authenticated = await this.authenticator.authenticate({ ...this.boundInput(input), path: '/api/v1/sessions/release' });
    const now = this.clock();
    const claim = await this.idempotency.claim<SessionReleaseResponseData>({
      actionType: 'SESSION_RELEASE', key: input.idempotencyKey, requestHash: authenticated.requestHash,
      now, expiresAt: new Date(now.getTime() + this.idempotencyTtlSeconds * 1_000),
    });
    if (claim.kind === 'COMPLETED') return claim.response;
    if (claim.kind === 'CONFLICT') throw new AppError({ code: 'IDEMPOTENCY_CONFLICT', message: '同一个幂等键不能用于不同的会话释放请求', statusCode: 409 });
    if (claim.kind === 'PROCESSING') throw new AppError({ code: 'REQUEST_IN_PROGRESS', message: '相同会话释放请求正在处理中', statusCode: 409, retryable: true });

    try {
      await this.authenticator.assertNotReplayed(authenticated);
      const credential = authenticated.deviceCredential;
      const token = authenticated.licenseToken;
      const result = await this.repository.releaseSession({
        tenantId: credential.tenant_id, productCode: input.productCode, licenseId: credential.license_id,
        deviceId: credential.device_id, activationId: credential.activation_id, sessionId: token.session_id,
        tokenJti: token.jti, clientVersion: input.clientVersion, now, requestId: input.requestId, ipAddress: input.ipAddress,
      });
      await this.onlineStore.remove(result.sessionId);
      const response: SessionReleaseResponseData = {
        released: true, license_id: result.licenseId, device_id: result.deviceId,
        activation_id: result.activationId, session_id: result.sessionId,
        session_status: 'REVOKED', released_at: result.releasedAt.toISOString(),
      };
      await this.idempotency.complete({ actionType: 'SESSION_RELEASE', key: input.idempotencyKey, requestHash: authenticated.requestHash, response, now });
      return response;
    } catch (error) {
      await this.idempotency.release('SESSION_RELEASE', input.idempotencyKey, authenticated.requestHash);
      throw error;
    }
  }

  private boundInput(input: SessionReleaseInput): Omit<BoundLicenseRequestInput, 'path'> {
    return {
      productCode: input.productCode, clientVersion: input.clientVersion, timestamp: input.timestamp,
      clientNonce: input.clientNonce, deviceId: input.deviceId, deviceKeyId: input.deviceKeyId,
      idempotencyKey: input.idempotencyKey, signature: input.signature, body: input.body,
      deviceCertificate: input.deviceCertificate, licenseToken: input.licenseToken,
    };
  }
}

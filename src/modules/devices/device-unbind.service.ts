import { AppError } from '../../shared/errors/app-error.js';
import type { Clock } from '../challenges/challenge.service.js';
import type { SessionActionIdempotencyStore } from '../session-actions/session-action-idempotency.store.js';
import type { OnlineSessionStore } from '../sessions/online-session.store.js';
import type { BoundLicenseRequestInput, DeviceRequestAuthenticator } from '../verification/device-request-authenticator.js';
import type { LicenseRuntimeRepository } from '../verification/license-runtime.repository.js';

export interface DeviceUnbindInput extends Omit<BoundLicenseRequestInput, 'path'> {
  idempotencyKey: string;
  reason: 'USER_REQUEST';
  requestId: string;
  ipAddress: string | null;
}

export interface DeviceUnbindResponseData {
  unbound: true;
  license_id: string;
  device_id: string;
  activation_id: string;
  activation_status: 'UNBOUND';
  revoked_session_count: number;
  unbound_at: string;
}

export class DeviceUnbindService {
  public constructor(
    private readonly authenticator: DeviceRequestAuthenticator,
    private readonly repository: LicenseRuntimeRepository,
    private readonly idempotency: SessionActionIdempotencyStore,
    private readonly onlineStore: OnlineSessionStore,
    private readonly idempotencyTtlSeconds: number,
    private readonly clock: Clock = () => new Date(),
  ) {}

  public async unbind(input: DeviceUnbindInput): Promise<DeviceUnbindResponseData> {
    const authenticated = await this.authenticator.authenticate({ ...this.boundInput(input), path: '/api/v1/devices/unbind' });
    const now = this.clock();
    const claim = await this.idempotency.claim<DeviceUnbindResponseData>({
      actionType: 'DEVICE_UNBIND', key: input.idempotencyKey, requestHash: authenticated.requestHash,
      now, expiresAt: new Date(now.getTime() + this.idempotencyTtlSeconds * 1_000),
    });
    if (claim.kind === 'COMPLETED') return claim.response;
    if (claim.kind === 'CONFLICT') throw new AppError({ code: 'IDEMPOTENCY_CONFLICT', message: '同一个幂等键不能用于不同的设备解绑请求', statusCode: 409 });
    if (claim.kind === 'PROCESSING') throw new AppError({ code: 'REQUEST_IN_PROGRESS', message: '相同设备解绑请求正在处理中', statusCode: 409, retryable: true });

    try {
      await this.authenticator.assertNotReplayed(authenticated);
      const credential = authenticated.deviceCredential;
      const token = authenticated.licenseToken;
      const result = await this.repository.unbindDevice({
        tenantId: credential.tenant_id, productCode: input.productCode, licenseId: credential.license_id,
        deviceId: credential.device_id, activationId: credential.activation_id, sessionId: token.session_id,
        tokenJti: token.jti, clientVersion: input.clientVersion, now, requestId: input.requestId, ipAddress: input.ipAddress,
      });
      await this.onlineStore.removeMany(result.revokedSessionIds);
      const response: DeviceUnbindResponseData = {
        unbound: true, license_id: result.licenseId, device_id: result.deviceId,
        activation_id: result.activationId, activation_status: 'UNBOUND',
        revoked_session_count: result.revokedSessionIds.length, unbound_at: result.unboundAt.toISOString(),
      };
      await this.idempotency.complete({ actionType: 'DEVICE_UNBIND', key: input.idempotencyKey, requestHash: authenticated.requestHash, response, now });
      return response;
    } catch (error) {
      await this.idempotency.release('DEVICE_UNBIND', input.idempotencyKey, authenticated.requestHash);
      throw error;
    }
  }

  private boundInput(input: DeviceUnbindInput): Omit<BoundLicenseRequestInput, 'path'> {
    return {
      productCode: input.productCode, clientVersion: input.clientVersion, timestamp: input.timestamp,
      clientNonce: input.clientNonce, deviceId: input.deviceId, deviceKeyId: input.deviceKeyId,
      idempotencyKey: input.idempotencyKey, signature: input.signature, body: input.body,
      deviceCertificate: input.deviceCertificate, licenseToken: input.licenseToken,
    };
  }
}

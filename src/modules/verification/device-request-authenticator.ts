import { AppError } from '../../shared/errors/app-error.js';
import { sha256Hex } from '../../shared/cryptography/canonical-json.js';
import type { Clock } from '../challenges/challenge.service.js';
import type { CompactTokenVerifier, DeviceCredentialClaims, LicenseTokenClaims } from '../cryptography/compact-token-verifier.js';
import { boundRequestSigningPayload, type BoundRequestPath, type Ed25519DeviceSignatureVerifier } from '../cryptography/ed25519-device-signature-verifier.js';
import type { RequestReplayStore } from '../security/request-replay.store.js';
import type { LicenseRuntimeRepository } from './license-runtime.repository.js';

export interface BoundLicenseRequestInput {
  path: BoundRequestPath;
  productCode: string;
  clientVersion: string;
  timestamp: string;
  clientNonce: string;
  deviceId: string;
  deviceKeyId: string;
  idempotencyKey?: string;
  signature: string;
  body: Readonly<Record<string, unknown>>;
  deviceCertificate: string;
  licenseToken: string;
}

export interface AuthenticatedDeviceRequest {
  input: BoundLicenseRequestInput;
  deviceCredential: DeviceCredentialClaims;
  licenseToken: LicenseTokenClaims;
  requestHash: string;
}

export interface DeviceRequestAuthenticatorOptions {
  issuer: string;
  requestMaxSkewSeconds: number;
  replayTtlSeconds: number;
}

export class DeviceRequestAuthenticator {
  public constructor(
    private readonly tokenVerifier: CompactTokenVerifier,
    private readonly signatureVerifier: Ed25519DeviceSignatureVerifier,
    private readonly repository: LicenseRuntimeRepository,
    private readonly replayStore: RequestReplayStore,
    private readonly options: DeviceRequestAuthenticatorOptions,
    private readonly clock: Clock = () => new Date(),
  ) {}

  public async authenticate(input: BoundLicenseRequestInput): Promise<AuthenticatedDeviceRequest> {
    const now = this.clock();
    const requestTime = new Date(input.timestamp);
    if (!Number.isFinite(requestTime.getTime())) throw invalidRequest('请求时间格式无效');
    if (Math.abs(now.getTime() - requestTime.getTime()) > this.options.requestMaxSkewSeconds * 1_000) {
      throw new AppError({ code: 'REQUEST_EXPIRED', message: '请求时间超出允许范围', statusCode: 408, retryable: true });
    }

    const verificationOptions = { issuer: this.options.issuer, audience: input.productCode, now };
    const [deviceCredential, licenseToken] = await Promise.all([
      this.tokenVerifier.verifyDeviceCredential(input.deviceCertificate, verificationOptions),
      this.tokenVerifier.verifyLicenseToken(input.licenseToken, verificationOptions),
    ]);
    this.requireConsistentClaims(deviceCredential, licenseToken, input);

    const identity = await this.repository.loadDeviceRequestIdentity({
      tenantId: deviceCredential.tenant_id,
      productCode: input.productCode,
      licenseId: deviceCredential.license_id,
      deviceId: deviceCredential.device_id,
      activationId: deviceCredential.activation_id,
    });
    if (identity.deviceKeyId !== input.deviceKeyId || identity.publicKeyFingerprint !== deviceCredential.device_public_key_fingerprint) {
      throw new AppError({ code: 'DEVICE_CREDENTIAL_INVALID', message: '设备凭证与服务器登记信息不一致', statusCode: 401 });
    }

    const signingInput = {
      method: 'POST' as const,
      path: input.path,
      productCode: input.productCode,
      clientVersion: input.clientVersion,
      timestamp: input.timestamp,
      clientNonce: input.clientNonce,
      deviceId: input.deviceId,
      deviceKeyId: input.deviceKeyId,
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      body: input.body,
    };
    const proof = this.signatureVerifier.verifyBoundRequest({
      ...signingInput,
      publicKeyPem: identity.publicKeyPem,
      signature: input.signature,
    });
    if (proof.publicKeyFingerprint !== identity.publicKeyFingerprint) {
      throw new AppError({ code: 'DEVICE_CREDENTIAL_INVALID', message: '设备公钥与服务器登记指纹不一致', statusCode: 401 });
    }

    return {
      input,
      deviceCredential,
      licenseToken,
      requestHash: sha256Hex(boundRequestSigningPayload(signingInput)),
    };
  }

  public async assertNotReplayed(request: AuthenticatedDeviceRequest): Promise<void> {
    const claimed = await this.replayStore.claim({
      deviceId: request.deviceCredential.device_id,
      clientNonce: request.input.clientNonce,
      requestHash: request.requestHash,
      ttlSeconds: this.options.replayTtlSeconds,
    });
    if (!claimed) throw new AppError({ code: 'REPLAY_DETECTED', message: '相同设备随机数已被使用', statusCode: 409 });
  }

  private requireConsistentClaims(
    credential: DeviceCredentialClaims,
    token: LicenseTokenClaims,
    input: BoundLicenseRequestInput,
  ): void {
    const fields: Array<[unknown, unknown]> = [
      [credential.tenant_id, token.tenant_id],
      [credential.license_id, token.license_id],
      [credential.device_id, token.device_id],
      [credential.activation_id, token.activation_id],
      [credential.aud, token.aud],
    ];
    if (fields.some(([left, right]) => left !== right) || credential.sub !== credential.device_id || token.sub !== token.license_id) {
      throw new AppError({ code: 'TOKEN_CONTEXT_MISMATCH', message: '设备凭证与授权令牌不属于同一授权上下文', statusCode: 401 });
    }
    if (input.deviceId !== credential.device_id || input.deviceKeyId !== credential.device_key_id) {
      throw new AppError({ code: 'DEVICE_CREDENTIAL_INVALID', message: '请求头设备身份与设备凭证不一致', statusCode: 401 });
    }
  }
}

function invalidRequest(message: string): AppError {
  return new AppError({ code: 'INVALID_REQUEST', message, statusCode: 400 });
}

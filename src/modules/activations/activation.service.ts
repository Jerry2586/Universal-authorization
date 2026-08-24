import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors/app-error.js';
import { sha256Hex } from '../../shared/cryptography/canonical-json.js';
import type { ChallengeService, Clock } from '../challenges/challenge.service.js';
import type { LicenseKeyCodec } from '../licenses/license-key-codec.js';
import { activationSigningPayload, type ActivationSignatureBody, Ed25519DeviceSignatureVerifier } from '../cryptography/ed25519-device-signature-verifier.js';
import type { CompactTokenIssuer } from '../cryptography/compact-token-issuer.js';
import type { ActivationIdempotencyStore } from './activation-idempotency.store.js';
import type { ActivationRepository } from './activation.repository.js';

export interface ActivateLicenseInput extends ActivationSignatureBody {
  deviceKeyId: string;
  signature: string;
  requestId: string;
  ipAddress: string | null;
}

export interface ActivationResponseFeature {
  code: string;
  allowed: boolean;
  limits: Readonly<Record<string, unknown>>;
  expires_at: string | null;
}

export interface ActivationResponseData {
  license_id: string;
  device_id: string;
  activation_id: string;
  session_id: string;
  license_status: 'ACTIVE';
  repeated_activation: boolean;
  issued_at: string;
  expires_at: string;
  license_expires_at: string | null;
  offline_until: string | null;
  heartbeat_interval_seconds: number;
  refresh_after_seconds: number;
  features: readonly ActivationResponseFeature[];
  device_certificate: string;
  license_token: string;
  signing_key_id: string;
}

export interface ActivationServiceOptions {
  requestMaxSkewSeconds: number;
  tokenTtlSeconds: number;
  certificateTtlSeconds: number;
  idempotencyTtlSeconds: number;
  heartbeatIntervalSeconds: number;
  refreshAfterSeconds: number;
  issuer: string;
}

export class ActivationService {
  public constructor(
    private readonly challenges: ChallengeService,
    private readonly repository: ActivationRepository,
    private readonly idempotency: ActivationIdempotencyStore,
    private readonly keyCodec: LicenseKeyCodec,
    private readonly signatureVerifier: Ed25519DeviceSignatureVerifier,
    private readonly tokenIssuer: CompactTokenIssuer,
    private readonly options: ActivationServiceOptions,
    private readonly clock: Clock = () => new Date(),
  ) {}

  public async activate(input: ActivateLicenseInput): Promise<ActivationResponseData> {
    const now = this.clock();
    const requestTime = new Date(input.timestamp);
    if (!Number.isFinite(requestTime.getTime())) throw invalidRequestTime();
    if (Math.abs(now.getTime() - requestTime.getTime()) > this.options.requestMaxSkewSeconds * 1_000) {
      throw new AppError({ code: 'REQUEST_EXPIRED', message: '激活请求时间超出允许范围', statusCode: 408, retryable: true });
    }

    await this.tokenIssuer.ensureReady();
    const signatureBody = this.signatureBody(input);
    const requestHash = sha256Hex(activationSigningPayload(signatureBody, input.deviceKeyId));
    const claim = await this.idempotency.claim({
      key: input.idempotency_key,
      requestHash,
      now,
      expiresAt: new Date(now.getTime() + this.options.idempotencyTtlSeconds * 1_000),
    });

    if (claim.kind === 'COMPLETED') return claim.response;
    if (claim.kind === 'CONFLICT') {
      throw new AppError({ code: 'IDEMPOTENCY_CONFLICT', message: '同一个幂等键不能用于不同的激活请求', statusCode: 409 });
    }
    if (claim.kind === 'PROCESSING') {
      throw new AppError({ code: 'REQUEST_IN_PROGRESS', message: '相同激活请求正在处理中', statusCode: 409, retryable: true });
    }

    let sessionId: string | undefined;
    let artifactsIssued = false;
    try {
      const challenge = await this.challenges.consume(input.server_nonce);
      if (challenge === null) {
        throw new AppError({ code: 'REPLAY_DETECTED', message: '挑战值无效、已过期或已被使用', statusCode: 409 });
      }
      if (challenge.productCode !== input.product_code || challenge.clientNonce !== input.client_nonce) {
        throw new AppError({ code: 'CHALLENGE_MISMATCH', message: '挑战值与当前激活请求不匹配', statusCode: 400 });
      }

      const proof = this.signatureVerifier.verifyActivation({ body: signatureBody, deviceKeyId: input.deviceKeyId, signature: input.signature });
      const keyHash = this.keyCodec.hash(input.license_key);
      sessionId = randomUUID();
      const grant = await this.repository.activate({
        productCode: input.product_code,
        keyHash,
        devicePublicKey: input.device_public_key,
        devicePublicKeyFingerprint: proof.publicKeyFingerprint,
        deviceFingerprintHash: input.device_fingerprint_hash.toLowerCase(),
        deviceName: input.device_name ?? null,
        platform: input.platform,
        osVersion: input.os_version ?? null,
        clientVersion: input.client_version,
        deviceKeyId: input.deviceKeyId,
        sessionId,
        tokenJti: randomUUID(),
        tokenTtlSeconds: this.options.tokenTtlSeconds,
        now,
        requestId: input.requestId,
        ipAddress: input.ipAddress,
      });

      const certificateLimit = new Date(now.getTime() + this.options.certificateTtlSeconds * 1_000);
      const certificateExpiresAt = grant.licenseExpiresAt === null || grant.licenseExpiresAt > certificateLimit
        ? certificateLimit
        : grant.licenseExpiresAt;
      const artifacts = await this.tokenIssuer.issue({
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
        certificateExpiresAt,
        devicePublicKeyFingerprint: grant.devicePublicKeyFingerprint,
        deviceKeyId: grant.deviceKeyId,
        features: grant.features.map((feature) => ({
          code: feature.code,
          allowed: feature.allowed,
          limits: feature.limits,
          expires_at: feature.expiresAt?.toISOString() ?? null,
        })),
        maxDevices: grant.maxDevices,
        maxConcurrentSessions: grant.maxConcurrentSessions,
      });

      artifactsIssued = true;
      const response: ActivationResponseData = {
        license_id: grant.licenseId,
        device_id: grant.deviceId,
        activation_id: grant.activationId,
        session_id: grant.sessionId,
        license_status: grant.licenseStatus,
        repeated_activation: grant.repeatedActivation,
        issued_at: grant.issuedAt.toISOString(),
        expires_at: grant.tokenExpiresAt.toISOString(),
        license_expires_at: grant.licenseExpiresAt?.toISOString() ?? null,
        offline_until: grant.offlineUntil?.toISOString() ?? null,
        heartbeat_interval_seconds: this.options.heartbeatIntervalSeconds,
        refresh_after_seconds: Math.min(this.options.refreshAfterSeconds, this.options.tokenTtlSeconds),
        features: grant.features.map((feature) => ({
          code: feature.code,
          allowed: feature.allowed,
          limits: feature.limits,
          expires_at: feature.expiresAt?.toISOString() ?? null,
        })),
        device_certificate: artifacts.deviceCertificate,
        license_token: artifacts.licenseToken,
        signing_key_id: artifacts.signingKeyId,
      };
      await this.idempotency.complete({ key: input.idempotency_key, requestHash, response, now });
      return response;
    } catch (error) {
      if (sessionId !== undefined && !artifactsIssued) await this.repository.revokeSession(sessionId, now).catch(() => undefined);
      await this.idempotency.release(input.idempotency_key, requestHash).catch(() => undefined);
      throw error;
    }
  }

  private signatureBody(input: ActivateLicenseInput): ActivationSignatureBody {
    return {
      product_code: input.product_code,
      license_key: input.license_key,
      device_public_key: input.device_public_key,
      device_fingerprint_hash: input.device_fingerprint_hash,
      ...(input.device_name === undefined ? {} : { device_name: input.device_name }),
      platform: input.platform,
      ...(input.os_version === undefined ? {} : { os_version: input.os_version }),
      client_version: input.client_version,
      server_nonce: input.server_nonce,
      client_nonce: input.client_nonce,
      timestamp: input.timestamp,
      idempotency_key: input.idempotency_key,
    };
  }
}

function invalidRequestTime(): AppError {
  return new AppError({ code: 'INVALID_REQUEST', message: '激活请求时间格式无效', statusCode: 400 });
}



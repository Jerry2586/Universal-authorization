import { describe, expect, it } from 'vitest';
import { CompactTokenVerifier } from '../src/modules/cryptography/compact-token-verifier.js';
import { Ed25519DeviceSignatureVerifier } from '../src/modules/cryptography/ed25519-device-signature-verifier.js';
import { InMemoryLicenseRefreshIdempotencyStore } from '../src/modules/refresh/infrastructure/in-memory-license-refresh-idempotency.store.js';
import { LicenseRefreshService } from '../src/modules/refresh/license-refresh.service.js';
import { InMemoryRequestReplayStore } from '../src/modules/security/infrastructure/in-memory-request-replay.store.js';
import { DeviceRequestAuthenticator } from '../src/modules/verification/device-request-authenticator.js';
import { createRuntimeCrypto, FakeLicenseRuntimeRepository, makeRefreshBody, runtimeIds, signRuntimeRequest } from './runtime-test-helpers.js';

const now = new Date('2026-08-24T12:05:00.000Z');

describe('LicenseRefreshService', () => {
  it('rotates the database session, keeps business expiry and returns the same result for an exact retry', async () => {
    const crypto = await createRuntimeCrypto(new Date('2026-08-24T12:00:00.000Z'));
    const repository = new FakeLicenseRuntimeRepository(crypto.devicePublicKeyPem, crypto.devicePublicKeyFingerprint);
    const businessExpiry = new Date('2026-09-30T00:00:00.000Z');
    repository.grant = { ...repository.grant, licenseExpiresAt: businessExpiry };
    const authenticator = new DeviceRequestAuthenticator(
      new CompactTokenVerifier(crypto.provider), new Ed25519DeviceSignatureVerifier(), repository,
      new InMemoryRequestReplayStore(() => now),
      { issuer: 'universal-license-server', requestMaxSkewSeconds: 300, replayTtlSeconds: 300 }, () => now,
    );
    const service = new LicenseRefreshService(
      authenticator, repository, new InMemoryLicenseRefreshIdempotencyStore(), crypto.issuer,
      { tokenTtlSeconds: 900, idempotencyTtlSeconds: 86_400, heartbeatIntervalSeconds: 60, refreshAfterSeconds: 600, issuer: 'universal-license-server' },
      () => now,
    );
    const body = makeRefreshBody(crypto.artifacts, now.toISOString());
    const input = {
      productCode: 'demo-product', clientVersion: body.client_version, timestamp: body.timestamp,
      clientNonce: body.client_nonce, deviceId: runtimeIds.deviceId, deviceKeyId: 'device-key-v1',
      idempotencyKey: body.idempotency_key,
      signature: signRuntimeRequest({ path: '/api/v1/licenses/refresh', body, privateKey: crypto.devicePair.privateKey, idempotencyKey: body.idempotency_key }),
      body, deviceCertificate: body.device_certificate, licenseToken: body.license_token,
      requestId: 'refresh-request', ipAddress: '127.0.0.1',
    };
    const first = await service.refresh(input);
    const second = await service.refresh(input);
    expect(second).toEqual(first);
    expect(first.previous_session_id).toBe(runtimeIds.sessionId);
    expect(first.session_id).not.toBe(runtimeIds.sessionId);
    expect(first.license_expires_at).toBe(businessExpiry.toISOString());
    expect(repository.refreshCalls).toHaveLength(1);
  });

  it('rejects the same idempotency key when the signed request content changes', async () => {
    const crypto = await createRuntimeCrypto(new Date('2026-08-24T12:00:00.000Z'));
    const repository = new FakeLicenseRuntimeRepository(crypto.devicePublicKeyPem, crypto.devicePublicKeyFingerprint);
    const authenticator = new DeviceRequestAuthenticator(
      new CompactTokenVerifier(crypto.provider), new Ed25519DeviceSignatureVerifier(), repository,
      new InMemoryRequestReplayStore(() => now),
      { issuer: 'universal-license-server', requestMaxSkewSeconds: 300, replayTtlSeconds: 300 }, () => now,
    );
    const service = new LicenseRefreshService(
      authenticator, repository, new InMemoryLicenseRefreshIdempotencyStore(), crypto.issuer,
      { tokenTtlSeconds: 900, idempotencyTtlSeconds: 86_400, heartbeatIntervalSeconds: 60, refreshAfterSeconds: 600, issuer: 'universal-license-server' }, () => now,
    );
    const firstBody = makeRefreshBody(crypto.artifacts, now.toISOString());
    const firstInput = makeInput(firstBody, crypto.devicePair.privateKey);
    await service.refresh(firstInput);
    const changedBody = makeRefreshBody(crypto.artifacts, now.toISOString(), 'another-refresh-nonce-123456', firstBody.idempotency_key);
    await expect(service.refresh(makeInput(changedBody, crypto.devicePair.privateKey)))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
});

function makeInput(body: ReturnType<typeof makeRefreshBody>, privateKey: Parameters<typeof signRuntimeRequest>[0]['privateKey']) {
  return {
    productCode: 'demo-product', clientVersion: body.client_version, timestamp: body.timestamp,
    clientNonce: body.client_nonce, deviceId: runtimeIds.deviceId, deviceKeyId: 'device-key-v1',
    idempotencyKey: body.idempotency_key,
    signature: signRuntimeRequest({ path: '/api/v1/licenses/refresh', body, privateKey, idempotencyKey: body.idempotency_key }),
    body, deviceCertificate: body.device_certificate, licenseToken: body.license_token,
    requestId: 'refresh-request', ipAddress: '127.0.0.1',
  };
}

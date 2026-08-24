import { describe, expect, it } from 'vitest';
import { CompactTokenVerifier } from '../src/modules/cryptography/compact-token-verifier.js';
import { Ed25519DeviceSignatureVerifier } from '../src/modules/cryptography/ed25519-device-signature-verifier.js';
import { InMemoryRequestReplayStore } from '../src/modules/security/infrastructure/in-memory-request-replay.store.js';
import { InMemorySessionActionIdempotencyStore } from '../src/modules/session-actions/infrastructure/in-memory-session-action-idempotency.store.js';
import { InMemoryOnlineSessionStore } from '../src/modules/sessions/infrastructure/in-memory-online-session.store.js';
import { SessionReleaseService } from '../src/modules/sessions/session-release.service.js';
import { DeviceRequestAuthenticator } from '../src/modules/verification/device-request-authenticator.js';
import { createRuntimeCrypto, FakeLicenseRuntimeRepository, makeVerifyBody, runtimeIds, signRuntimeRequest } from './runtime-test-helpers.js';

const now = new Date('2026-08-24T12:05:00.000Z');

describe('SessionReleaseService', () => {
  it('revokes only the current session, removes online state and supports exact retry', async () => {
    const crypto = await createRuntimeCrypto(new Date('2026-08-24T12:00:00.000Z'));
    const repository = new FakeLicenseRuntimeRepository(crypto.devicePublicKeyPem, crypto.devicePublicKeyFingerprint);
    const authenticator = new DeviceRequestAuthenticator(
      new CompactTokenVerifier(crypto.provider), new Ed25519DeviceSignatureVerifier(), repository,
      new InMemoryRequestReplayStore(() => now),
      { issuer: 'universal-license-server', requestMaxSkewSeconds: 300, replayTtlSeconds: 300 }, () => now,
    );
    const online = new InMemoryOnlineSessionStore(() => now);
    await online.markOnline({ sessionId: runtimeIds.sessionId, licenseId: runtimeIds.licenseId, deviceId: runtimeIds.deviceId,
      activationId: runtimeIds.activationId, lastHeartbeatAt: now, sequence: 1 }, 180);
    const service = new SessionReleaseService(authenticator, repository,
      new InMemorySessionActionIdempotencyStore(), online, 86_400, () => now);
    const body = { ...makeVerifyBody(crypto.artifacts, now.toISOString(), 'release-nonce-123456'), idempotency_key: 'release-idempotency-123456' };
    const input = makeInput(body, crypto.devicePair.privateKey);
    const first = await service.release(input);
    const second = await service.release(input);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ released: true, session_status: 'REVOKED', session_id: runtimeIds.sessionId });
    expect(repository.releaseCalls).toHaveLength(1);
    expect(online.get(runtimeIds.sessionId)).toBeUndefined();
  });

  it('rejects reusing the same idempotency key for changed signed content', async () => {
    const crypto = await createRuntimeCrypto(new Date('2026-08-24T12:00:00.000Z'));
    const repository = new FakeLicenseRuntimeRepository(crypto.devicePublicKeyPem, crypto.devicePublicKeyFingerprint);
    const authenticator = new DeviceRequestAuthenticator(
      new CompactTokenVerifier(crypto.provider), new Ed25519DeviceSignatureVerifier(), repository,
      new InMemoryRequestReplayStore(() => now),
      { issuer: 'universal-license-server', requestMaxSkewSeconds: 300, replayTtlSeconds: 300 }, () => now,
    );
    const service = new SessionReleaseService(authenticator, repository,
      new InMemorySessionActionIdempotencyStore(), new InMemoryOnlineSessionStore(() => now), 86_400, () => now);
    const first = { ...makeVerifyBody(crypto.artifacts, now.toISOString(), 'release-nonce-123456'), idempotency_key: 'release-idempotency-123456' };
    await service.release(makeInput(first, crypto.devicePair.privateKey));
    const changed = { ...first, client_nonce: 'changed-release-nonce-123456' };
    await expect(service.release(makeInput(changed, crypto.devicePair.privateKey))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
});

function makeInput(body: ReturnType<typeof makeVerifyBody> & { idempotency_key: string }, privateKey: Parameters<typeof signRuntimeRequest>[0]['privateKey']) {
  return {
    productCode: 'demo-product', clientVersion: body.client_version, timestamp: body.timestamp,
    clientNonce: body.client_nonce, deviceId: runtimeIds.deviceId, deviceKeyId: 'device-key-v1',
    idempotencyKey: body.idempotency_key,
    signature: signRuntimeRequest({ path: '/api/v1/sessions/release', body, privateKey, idempotencyKey: body.idempotency_key }),
    body, deviceCertificate: body.device_certificate, licenseToken: body.license_token,
    requestId: 'release-request', ipAddress: '127.0.0.1',
  };
}

import { describe, expect, it } from 'vitest';
import { CompactTokenVerifier } from '../src/modules/cryptography/compact-token-verifier.js';
import { Ed25519DeviceSignatureVerifier } from '../src/modules/cryptography/ed25519-device-signature-verifier.js';
import { InMemoryRequestReplayStore } from '../src/modules/security/infrastructure/in-memory-request-replay.store.js';
import { InMemorySessionActionIdempotencyStore } from '../src/modules/session-actions/infrastructure/in-memory-session-action-idempotency.store.js';
import { InMemoryOnlineSessionStore } from '../src/modules/sessions/infrastructure/in-memory-online-session.store.js';
import { DeviceUnbindService } from '../src/modules/devices/device-unbind.service.js';
import { DeviceRequestAuthenticator } from '../src/modules/verification/device-request-authenticator.js';
import { createRuntimeCrypto, FakeLicenseRuntimeRepository, makeVerifyBody, runtimeIds, signRuntimeRequest } from './runtime-test-helpers.js';

const now = new Date('2026-08-24T12:05:00.000Z');

describe('DeviceUnbindService', () => {
  it('unbinds the activation, removes all returned online sessions and supports exact retry', async () => {
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
    const service = new DeviceUnbindService(authenticator, repository,
      new InMemorySessionActionIdempotencyStore(), online, 86_400, () => now);
    const body = { ...makeVerifyBody(crypto.artifacts, now.toISOString(), 'unbind-nonce-123456'),
      idempotency_key: 'unbind-idempotency-123456', reason: 'USER_REQUEST' as const };
    const input = {
      productCode: 'demo-product', clientVersion: body.client_version, timestamp: body.timestamp,
      clientNonce: body.client_nonce, deviceId: runtimeIds.deviceId, deviceKeyId: 'device-key-v1',
      idempotencyKey: body.idempotency_key, reason: body.reason,
      signature: signRuntimeRequest({ path: '/api/v1/devices/unbind', body, privateKey: crypto.devicePair.privateKey, idempotencyKey: body.idempotency_key }),
      body, deviceCertificate: body.device_certificate, licenseToken: body.license_token,
      requestId: 'unbind-request', ipAddress: '127.0.0.1',
    };
    const first = await service.unbind(input);
    const second = await service.unbind(input);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ unbound: true, activation_status: 'UNBOUND', revoked_session_count: 1 });
    expect(repository.unbindCalls).toHaveLength(1);
    expect(online.get(runtimeIds.sessionId)).toBeUndefined();
  });
});

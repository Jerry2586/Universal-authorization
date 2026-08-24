import { describe, expect, it } from 'vitest';
import { CompactTokenVerifier } from '../src/modules/cryptography/compact-token-verifier.js';
import { Ed25519DeviceSignatureVerifier } from '../src/modules/cryptography/ed25519-device-signature-verifier.js';
import { InMemoryRequestReplayStore } from '../src/modules/security/infrastructure/in-memory-request-replay.store.js';
import { InMemoryOnlineSessionStore } from '../src/modules/sessions/infrastructure/in-memory-online-session.store.js';
import { SessionHeartbeatService } from '../src/modules/sessions/session-heartbeat.service.js';
import { DeviceRequestAuthenticator } from '../src/modules/verification/device-request-authenticator.js';
import { createRuntimeCrypto, FakeLicenseRuntimeRepository, makeVerifyBody, runtimeIds, signRuntimeRequest } from './runtime-test-helpers.js';

const now = new Date('2026-08-24T12:05:00.000Z');

describe('SessionHeartbeatService', () => {
  it('records a verified heartbeat and marks the session online', async () => {
    const crypto = await createRuntimeCrypto(new Date('2026-08-24T12:00:00.000Z'));
    const repository = new FakeLicenseRuntimeRepository(crypto.devicePublicKeyPem, crypto.devicePublicKeyFingerprint);
    const replay = new InMemoryRequestReplayStore(() => now);
    const authenticator = new DeviceRequestAuthenticator(
      new CompactTokenVerifier(crypto.provider), new Ed25519DeviceSignatureVerifier(), repository, replay,
      { issuer: 'universal-license-server', requestMaxSkewSeconds: 300, replayTtlSeconds: 300 }, () => now,
    );
    const online = new InMemoryOnlineSessionStore(() => now);
    const service = new SessionHeartbeatService(authenticator, repository, online,
      { heartbeatIntervalSeconds: 60, onlineTtlSeconds: 180, refreshAfterSeconds: 600 }, () => now);
    const body = { ...makeVerifyBody(crypto.artifacts, now.toISOString(), 'heartbeat-nonce-123456'), sequence: 1 };
    const input = {
      productCode: 'demo-product', clientVersion: body.client_version, timestamp: body.timestamp,
      clientNonce: body.client_nonce, deviceId: runtimeIds.deviceId, deviceKeyId: 'device-key-v1',
      signature: signRuntimeRequest({ path: '/api/v1/sessions/heartbeat', body, privateKey: crypto.devicePair.privateKey }),
      body, deviceCertificate: body.device_certificate, licenseToken: body.license_token,
      sequence: body.sequence, requestId: 'heartbeat-request', ipAddress: '127.0.0.1',
    };
    const result = await service.heartbeat(input);
    expect(result).toMatchObject({ online: true, session_id: runtimeIds.sessionId, online_ttl_seconds: 180 });
    expect(result.next_heartbeat_at).toBe('2026-08-24T12:06:00.000Z');
    expect(repository.heartbeatCalls).toHaveLength(1);
    expect(online.get(runtimeIds.sessionId)).toMatchObject({ sequence: 1, deviceId: runtimeIds.deviceId });
    await expect(service.heartbeat(input)).rejects.toMatchObject({ code: 'REPLAY_DETECTED' });
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { CompactTokenVerifier } from '../src/modules/cryptography/compact-token-verifier.js';
import { Ed25519DeviceSignatureVerifier } from '../src/modules/cryptography/ed25519-device-signature-verifier.js';
import { InMemoryLicenseRefreshIdempotencyStore } from '../src/modules/refresh/infrastructure/in-memory-license-refresh-idempotency.store.js';
import { InMemoryRequestReplayStore } from '../src/modules/security/infrastructure/in-memory-request-replay.store.js';
import { InMemorySessionActionIdempotencyStore } from '../src/modules/session-actions/infrastructure/in-memory-session-action-idempotency.store.js';
import { InMemoryOnlineSessionStore } from '../src/modules/sessions/infrastructure/in-memory-online-session.store.js';
import { createRuntimeCrypto, FakeLicenseRuntimeRepository, makeVerifyBody, runtimeIds, signRuntimeRequest } from './runtime-test-helpers.js';

const now = new Date('2026-08-24T12:05:00.000Z');
let app: FastifyInstance | undefined;

afterEach(async () => { if (app !== undefined) { await app.close(); app = undefined; } });

describe('sixth-stage session lifecycle routes', () => {
  it('exposes heartbeat, release and self-unbind while later/admin device routes remain absent', async () => {
    const crypto = await createRuntimeCrypto(new Date('2026-08-24T12:00:00.000Z'));
    const repository = new FakeLicenseRuntimeRepository(crypto.devicePublicKeyPem, crypto.devicePublicKeyFingerprint);
    app = buildApp({
      clock: () => now,
      licenseRuntime: {
        repository,
        refreshIdempotency: new InMemoryLicenseRefreshIdempotencyStore(),
        replayStore: new InMemoryRequestReplayStore(() => now),
        signatureVerifier: new Ed25519DeviceSignatureVerifier(),
        tokenVerifier: new CompactTokenVerifier(crypto.provider),
        tokenIssuer: crypto.issuer,
        authenticatorOptions: { issuer: 'universal-license-server', requestMaxSkewSeconds: 300, replayTtlSeconds: 300 },
        refreshOptions: { tokenTtlSeconds: 900, idempotencyTtlSeconds: 86_400, heartbeatIntervalSeconds: 60, refreshAfterSeconds: 600, issuer: 'universal-license-server' },
        onlineSessionStore: new InMemoryOnlineSessionStore(() => now),
        sessionActionIdempotency: new InMemorySessionActionIdempotencyStore(),
        sessionActionIdempotencyTtlSeconds: 86_400,
        sessionHeartbeatOptions: { heartbeatIntervalSeconds: 60, onlineTtlSeconds: 180, refreshAfterSeconds: 600 },
      },
    });

    const heartbeatBody = { ...makeVerifyBody(crypto.artifacts, now.toISOString(), 'route-heartbeat-nonce-123456'), sequence: 1 };
    const heartbeat = await app.inject({
      method: 'POST', url: '/api/v1/sessions/heartbeat',
      headers: headers(heartbeatBody, signRuntimeRequest({ path: '/api/v1/sessions/heartbeat', body: heartbeatBody, privateKey: crypto.devicePair.privateKey })),
      payload: heartbeatBody,
    });
    expect(heartbeat.statusCode).toBe(200);
    expect(heartbeat.json()).toMatchObject({ success: true, data: { online: true, session_id: runtimeIds.sessionId } });

    const releaseBody = { ...makeVerifyBody(crypto.artifacts, now.toISOString(), 'route-release-nonce-123456'), idempotency_key: 'route-release-idempotency-123456' };
    const release = await app.inject({
      method: 'POST', url: '/api/v1/sessions/release',
      headers: { ...headers(releaseBody, signRuntimeRequest({ path: '/api/v1/sessions/release', body: releaseBody, privateKey: crypto.devicePair.privateKey, idempotencyKey: releaseBody.idempotency_key })), 'idempotency-key': releaseBody.idempotency_key },
      payload: releaseBody,
    });
    expect(release.statusCode).toBe(200);
    expect(release.json()).toMatchObject({ success: true, data: { released: true, session_status: 'REVOKED' } });

    const unbindBody = { ...makeVerifyBody(crypto.artifacts, now.toISOString(), 'route-unbind-nonce-123456'), idempotency_key: 'route-unbind-idempotency-123456', reason: 'USER_REQUEST' };
    const unbind = await app.inject({
      method: 'POST', url: '/api/v1/devices/unbind',
      headers: { ...headers(unbindBody, signRuntimeRequest({ path: '/api/v1/devices/unbind', body: unbindBody, privateKey: crypto.devicePair.privateKey, idempotencyKey: unbindBody.idempotency_key })), 'idempotency-key': unbindBody.idempotency_key },
      payload: unbindBody,
    });
    expect(unbind.statusCode).toBe(200);
    expect(unbind.json()).toMatchObject({ success: true, data: { unbound: true, activation_status: 'UNBOUND' } });

    for (const url of ['/admin/v1/devices/unbind', '/admin/v1/devices/block', '/api/v1/orders', '/api/v1/payments']) {
      const response = await app.inject({ method: 'POST', url });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'ROUTE_NOT_FOUND' });
    }
  });
});

function headers(body: { client_version: string; timestamp: string; client_nonce: string }, signature: string) {
  return {
    'x-product-code': 'demo-product', 'x-client-version': body.client_version,
    'x-timestamp': body.timestamp, 'x-client-nonce': body.client_nonce,
    'x-device-id': runtimeIds.deviceId, 'x-key-id': 'device-key-v1', 'x-signature': signature,
  };
}

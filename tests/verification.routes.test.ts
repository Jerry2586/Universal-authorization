import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { CompactTokenVerifier } from '../src/modules/cryptography/compact-token-verifier.js';
import { Ed25519DeviceSignatureVerifier } from '../src/modules/cryptography/ed25519-device-signature-verifier.js';
import { InMemoryLicenseRefreshIdempotencyStore } from '../src/modules/refresh/infrastructure/in-memory-license-refresh-idempotency.store.js';
import { InMemoryRequestReplayStore } from '../src/modules/security/infrastructure/in-memory-request-replay.store.js';
import { createRuntimeCrypto, FakeLicenseRuntimeRepository, makeRefreshBody, makeVerifyBody, runtimeIds, signRuntimeRequest } from './runtime-test-helpers.js';

const now = new Date('2026-08-24T12:05:00.000Z');
let app: FastifyInstance | undefined;

afterEach(async () => { if (app !== undefined) { await app.close(); app = undefined; } });

describe('verification and refresh routes', () => {
  it('exposes only the fifth-stage verify and refresh routes', async () => {
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
      },
    });

    const verifyBody = makeVerifyBody(crypto.artifacts, now.toISOString());
    const verifyResponse = await app.inject({
      method: 'POST', url: '/api/v1/licenses/verify',
      headers: headers(verifyBody, signRuntimeRequest({ path: '/api/v1/licenses/verify', body: verifyBody, privateKey: crypto.devicePair.privateKey })),
      payload: verifyBody,
    });
    expect(verifyResponse.statusCode).toBe(200);
    expect(verifyResponse.json()).toMatchObject({ success: true, data: { valid: true } });

    const refreshBody = makeRefreshBody(crypto.artifacts, now.toISOString(), 'route-refresh-nonce-123456');
    const refreshResponse = await app.inject({
      method: 'POST', url: '/api/v1/licenses/refresh',
      headers: {
        ...headers(refreshBody, signRuntimeRequest({ path: '/api/v1/licenses/refresh', body: refreshBody, privateKey: crypto.devicePair.privateKey, idempotencyKey: refreshBody.idempotency_key })),
        'idempotency-key': refreshBody.idempotency_key,
      },
      payload: refreshBody,
    });
    expect(refreshResponse.statusCode).toBe(200);
    expect(refreshResponse.json()).toMatchObject({ success: true, data: { previous_session_id: runtimeIds.sessionId, session_status: 'VALID' } });

    for (const url of ['/api/v1/sessions/heartbeat', '/api/v1/sessions/release', '/api/v1/devices/unbind']) {
      const response = await app.inject({ method: 'POST', url });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'ROUTE_NOT_FOUND' });
    }
  });
});

function headers(body: { client_version: string; timestamp: string; client_nonce: string }, signature: string) {
  return {
    'x-product-code': 'demo-product',
    'x-client-version': body.client_version,
    'x-timestamp': body.timestamp,
    'x-client-nonce': body.client_nonce,
    'x-device-id': runtimeIds.deviceId,
    'x-key-id': 'device-key-v1',
    'x-signature': signature,
  };
}

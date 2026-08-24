import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { InMemoryChallengeStore } from '../src/modules/challenges/infrastructure/in-memory-challenge.store.js';
import type { ActivationRepository, PersistActivationInput } from '../src/modules/activations/activation.repository.js';
import { InMemoryActivationIdempotencyStore } from '../src/modules/activations/infrastructure/in-memory-activation-idempotency.store.js';
import { HmacLicenseKeyCodec } from '../src/modules/licenses/license-key-codec.js';
import { activationSigningPayload, Ed25519DeviceSignatureVerifier, type ActivationSignatureBody } from '../src/modules/cryptography/ed25519-device-signature-verifier.js';
import { Ed25519FileSigningKeyProvider } from '../src/modules/cryptography/ed25519-file-signing-key-provider.js';
import { CompactTokenIssuer } from '../src/modules/cryptography/compact-token-issuer.js';

let app: FastifyInstance | undefined;
const now = new Date('2026-08-24T12:00:00.000Z');
afterEach(async () => { if (app !== undefined) { await app.close(); app = undefined; } });

describe('activation route', () => {
  it('activates through the public API with matching security headers', async () => {
    const deviceKeys = generateKeyPairSync('ed25519');
    const serverKeys = generateKeyPairSync('ed25519');
    const privatePem = serverKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    app = buildApp({
      challengeStore: new InMemoryChallengeStore(), challengeTtlSeconds: 120, clock: () => now,
      activation: {
        repository: new RouteRepository(), idempotency: new InMemoryActivationIdempotencyStore(),
        keyCodec: new HmacLicenseKeyCodec('test-pepper-at-least-thirty-two-characters-long'),
        signatureVerifier: new Ed25519DeviceSignatureVerifier(),
        tokenIssuer: new CompactTokenIssuer(new Ed25519FileSigningKeyProvider('route-signing-v1', Buffer.from(privatePem).toString('base64'))),
        options: { requestMaxSkewSeconds: 300, tokenTtlSeconds: 900, certificateTtlSeconds: 2_592_000,
          idempotencyTtlSeconds: 86_400, heartbeatIntervalSeconds: 60, refreshAfterSeconds: 600, issuer: 'route-test' },
      },
    });
    const challengeResponse = await app.inject({
      method: 'POST', url: '/api/v1/challenges',
      payload: { product_code: 'demo-product', client_nonce: 'client-nonce-1234567890' },
    });
    const serverNonce = challengeResponse.json().data.server_nonce as string;
    const body: ActivationSignatureBody = {
      product_code: 'demo-product', license_key: 'ULK1-ABCD-EFGH-JKMP-QRST-WXYZ',
      device_public_key: deviceKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      device_fingerprint_hash: 'b'.repeat(64), device_name: '路由测试电脑', platform: 'windows', os_version: 'Windows 11',
      client_version: '1.2.0', server_nonce: serverNonce, client_nonce: 'client-nonce-1234567890',
      timestamp: now.toISOString(), idempotency_key: 'route-idempotency-1234567890',
    };
    const signature = signBody(body, deviceKeys.privateKey);
    const response = await app.inject({
      method: 'POST', url: '/api/v1/licenses/activate', headers: {
        'x-request-id': 'route-activate-001', 'x-product-code': body.product_code,
        'x-client-version': body.client_version, 'x-timestamp': body.timestamp,
        'x-client-nonce': body.client_nonce, 'x-key-id': 'device-key-v1',
        'x-signature': signature, 'idempotency-key': body.idempotency_key,
      }, payload: body,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      request_id: 'route-activate-001', success: true, server_time: now.toISOString(),
      data: { license_status: 'ACTIVE', heartbeat_interval_seconds: 60, signing_key_id: 'route-signing-v1' },
    });
  });

  it('does not expose activation when the activation module is not configured', async () => {
    app = buildApp();
    const response = await app.inject({ method: 'POST', url: '/api/v1/licenses/activate', payload: {} });
    expect(response.statusCode).toBe(404);
  });
});

class RouteRepository implements ActivationRepository {
  public async activate(input: PersistActivationInput) {
    return {
      tenantId: '11111111-1111-4111-8111-111111111111', productId: '22222222-2222-4222-8222-222222222222',
      productCode: input.productCode, licenseId: '33333333-3333-4333-8333-333333333333', licenseType: 'DURATION',
      licenseStatus: 'ACTIVE' as const, licenseExpiresAt: new Date(input.now.getTime() + 86_400_000),
      deviceId: '44444444-4444-4444-8444-444444444444', activationId: '55555555-5555-4555-8555-555555555555',
      sessionId: input.sessionId, tokenJti: input.tokenJti, issuedAt: input.now,
      tokenExpiresAt: new Date(input.now.getTime() + input.tokenTtlSeconds * 1000),
      offlineUntil: new Date(input.now.getTime() + 86_400_000), repeatedActivation: false,
      devicePublicKeyFingerprint: input.devicePublicKeyFingerprint, deviceKeyId: input.deviceKeyId,
      maxDevices: 1, maxConcurrentSessions: 1, features: [],
    };
  }
  public async revokeSession(): Promise<void> {}
}

function signBody(body: ActivationSignatureBody, privateKey: KeyObject): string {
  return sign(null, Buffer.from(activationSigningPayload(body, 'device-key-v1')), privateKey).toString('base64url');
}



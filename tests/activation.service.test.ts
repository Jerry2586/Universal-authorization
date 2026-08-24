import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ChallengeService } from '../src/modules/challenges/challenge.service.js';
import { InMemoryChallengeStore } from '../src/modules/challenges/infrastructure/in-memory-challenge.store.js';
import { ActivationService, type ActivateLicenseInput } from '../src/modules/activations/activation.service.js';
import { InMemoryActivationIdempotencyStore } from '../src/modules/activations/infrastructure/in-memory-activation-idempotency.store.js';
import type { ActivationRepository, PersistActivationInput } from '../src/modules/activations/activation.repository.js';
import { HmacLicenseKeyCodec } from '../src/modules/licenses/license-key-codec.js';
import { Ed25519DeviceSignatureVerifier, activationSigningPayload, type ActivationSignatureBody } from '../src/modules/cryptography/ed25519-device-signature-verifier.js';
import { Ed25519FileSigningKeyProvider } from '../src/modules/cryptography/ed25519-file-signing-key-provider.js';
import { CompactTokenIssuer } from '../src/modules/cryptography/compact-token-issuer.js';

const now = new Date('2026-08-24T12:00:00.000Z');

describe('ActivationService', () => {
  it('consumes a challenge, verifies the device and returns an idempotent signed activation', async () => {
    const setup = await createSetup();
    const first = await setup.service.activate(setup.input);
    const second = await setup.service.activate(setup.input);

    expect(first).toEqual(second);
    expect(first).toMatchObject({ license_status: 'ACTIVE', repeated_activation: false, signing_key_id: 'test-signing-v1' });
    expect(first.license_token.split('.')).toHaveLength(3);
    expect(first.device_certificate.split('.')).toHaveLength(3);
    expect(setup.repository.activations).toHaveLength(1);
    await expect(setup.challengeService.consume(setup.input.server_nonce)).resolves.toBeNull();
  });

  it('rejects a replayed challenge when a new idempotency key is used', async () => {
    const setup = await createSetup();
    await setup.service.activate(setup.input);
    const replay = { ...setup.input, idempotency_key: 'second-idempotency-1234567890' };
    replay.signature = signInput(replay, setup.privateKey);
    await expect(setup.service.activate(replay)).rejects.toMatchObject({ code: 'REPLAY_DETECTED', statusCode: 409 });
  });

  it('rejects a request with an invalid device signature without creating an activation', async () => {
    const setup = await createSetup();
    const invalid = { ...setup.input, signature: Buffer.alloc(64).toString('base64url') };
    await expect(setup.service.activate(invalid)).rejects.toMatchObject({ code: 'SIGNATURE_INVALID', statusCode: 401 });
    expect(setup.repository.activations).toHaveLength(0);
  });
});

class FakeActivationRepository implements ActivationRepository {
  public readonly activations: PersistActivationInput[] = [];
  public async activate(input: PersistActivationInput) {
    this.activations.push(input);
    return {
      tenantId: '11111111-1111-4111-8111-111111111111', productId: '22222222-2222-4222-8222-222222222222',
      productCode: input.productCode, licenseId: '33333333-3333-4333-8333-333333333333', licenseType: 'PERPETUAL',
      licenseStatus: 'ACTIVE' as const, licenseExpiresAt: null, deviceId: '44444444-4444-4444-8444-444444444444',
      activationId: '55555555-5555-4555-8555-555555555555', sessionId: input.sessionId, tokenJti: input.tokenJti,
      issuedAt: input.now, tokenExpiresAt: new Date(input.now.getTime() + input.tokenTtlSeconds * 1000),
      offlineUntil: new Date(input.now.getTime() + 86_400_000), repeatedActivation: false,
      devicePublicKeyFingerprint: input.devicePublicKeyFingerprint, deviceKeyId: input.deviceKeyId,
      maxDevices: 1, maxConcurrentSessions: 1, features: [{ code: 'api.access', allowed: true, limits: {}, expiresAt: null }],
    };
  }
  public async revokeSession(): Promise<void> {}
}

async function createSetup() {
  const deviceKeys = generateKeyPairSync('ed25519');
  const serverKeys = generateKeyPairSync('ed25519');
  const store = new InMemoryChallengeStore();
  const challengeService = new ChallengeService(store, 120, () => now);
  const challenge = await challengeService.issue({ productCode: 'demo-product', clientNonce: 'client-nonce-1234567890' });
  const body: ActivationSignatureBody = {
    product_code: 'demo-product', license_key: 'ULK1-ABCD-EFGH-JKMP-QRST-WXYZ',
    device_public_key: deviceKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    device_fingerprint_hash: 'a'.repeat(64), device_name: '测试电脑', platform: 'windows', os_version: 'Windows 11',
    client_version: '1.2.0', server_nonce: challenge.serverNonce, client_nonce: 'client-nonce-1234567890',
    timestamp: now.toISOString(), idempotency_key: 'idem-activation-1234567890',
  };
  const privatePem = serverKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const repository = new FakeActivationRepository();
  const service = new ActivationService(
    challengeService, repository, new InMemoryActivationIdempotencyStore(),
    new HmacLicenseKeyCodec('test-pepper-at-least-thirty-two-characters-long'),
    new Ed25519DeviceSignatureVerifier(),
    new CompactTokenIssuer(new Ed25519FileSigningKeyProvider('test-signing-v1', Buffer.from(privatePem).toString('base64'))),
    { requestMaxSkewSeconds: 300, tokenTtlSeconds: 900, certificateTtlSeconds: 2_592_000,
      idempotencyTtlSeconds: 86_400, heartbeatIntervalSeconds: 60, refreshAfterSeconds: 600, issuer: 'test-server' },
    () => now,
  );
  const input: ActivateLicenseInput = {
    ...body, deviceKeyId: 'device-key-v1', signature: '', requestId: 'activate-test', ipAddress: '127.0.0.1',
  };
  input.signature = signInput(input, deviceKeys.privateKey);
  return { service, input, privateKey: deviceKeys.privateKey, repository, challengeService };
}

function signInput(input: ActivateLicenseInput, privateKey: KeyObject): string {
  const body: ActivationSignatureBody = {
    product_code: input.product_code, license_key: input.license_key, device_public_key: input.device_public_key,
    device_fingerprint_hash: input.device_fingerprint_hash, ...(input.device_name === undefined ? {} : { device_name: input.device_name }),
    platform: input.platform, ...(input.os_version === undefined ? {} : { os_version: input.os_version }),
    client_version: input.client_version, server_nonce: input.server_nonce, client_nonce: input.client_nonce,
    timestamp: input.timestamp, idempotency_key: input.idempotency_key,
  };
  return sign(null, Buffer.from(activationSigningPayload(body, 'device-key-v1')), privateKey).toString('base64url');
}



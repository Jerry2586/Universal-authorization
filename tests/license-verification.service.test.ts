import { describe, expect, it } from 'vitest';
import { CompactTokenVerifier } from '../src/modules/cryptography/compact-token-verifier.js';
import { Ed25519DeviceSignatureVerifier } from '../src/modules/cryptography/ed25519-device-signature-verifier.js';
import { InMemoryRequestReplayStore } from '../src/modules/security/infrastructure/in-memory-request-replay.store.js';
import { DeviceRequestAuthenticator } from '../src/modules/verification/device-request-authenticator.js';
import { LicenseVerificationService } from '../src/modules/verification/license-verification.service.js';
import { createRuntimeCrypto, FakeLicenseRuntimeRepository, makeVerifyBody, runtimeIds, signRuntimeRequest } from './runtime-test-helpers.js';

const now = new Date('2026-08-24T12:11:00.000Z');

describe('LicenseVerificationService', () => {
  it('returns current database features and marks a token ready to refresh', async () => {
    const issuedAt = new Date('2026-08-24T12:00:00.000Z');
    const crypto = await createRuntimeCrypto(issuedAt);
    const repository = new FakeLicenseRuntimeRepository(crypto.devicePublicKeyPem, crypto.devicePublicKeyFingerprint, 'device-key-v1', issuedAt);
    const authenticator = new DeviceRequestAuthenticator(
      new CompactTokenVerifier(crypto.provider), new Ed25519DeviceSignatureVerifier(), repository,
      new InMemoryRequestReplayStore(() => now),
      { issuer: 'universal-license-server', requestMaxSkewSeconds: 300, replayTtlSeconds: 300 }, () => now,
    );
    const service = new LicenseVerificationService(authenticator, repository, 600, () => now);
    const body = makeVerifyBody(crypto.artifacts, now.toISOString());
    const result = await service.verify({
      productCode: 'demo-product', clientVersion: body.client_version, timestamp: body.timestamp,
      clientNonce: body.client_nonce, deviceId: runtimeIds.deviceId, deviceKeyId: 'device-key-v1',
      signature: signRuntimeRequest({ path: '/api/v1/licenses/verify', body, privateKey: crypto.devicePair.privateKey }),
      body, deviceCertificate: body.device_certificate, licenseToken: body.license_token,
      requestId: 'verify-request', ipAddress: '127.0.0.1',
    });
    expect(result).toMatchObject({ valid: true, should_refresh: true, session_status: 'VALID' });
    expect(result.features[0]).toMatchObject({ code: 'api.access', limits: { rpm: 60 } });
    expect(repository.verifyCalls).toHaveLength(1);
  });
});

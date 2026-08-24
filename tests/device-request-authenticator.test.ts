import { describe, expect, it } from 'vitest';
import { CompactTokenVerifier } from '../src/modules/cryptography/compact-token-verifier.js';
import { Ed25519DeviceSignatureVerifier } from '../src/modules/cryptography/ed25519-device-signature-verifier.js';
import { DeviceRequestAuthenticator } from '../src/modules/verification/device-request-authenticator.js';
import { InMemoryRequestReplayStore } from '../src/modules/security/infrastructure/in-memory-request-replay.store.js';
import { createRuntimeCrypto, FakeLicenseRuntimeRepository, makeVerifyBody, runtimeIds, signRuntimeRequest } from './runtime-test-helpers.js';

const now = new Date('2026-08-24T12:00:00.000Z');

describe('DeviceRequestAuthenticator', () => {
  it('checks both tokens, the bound device signature and rejects a reused nonce', async () => {
    const crypto = await createRuntimeCrypto(now);
    const repository = new FakeLicenseRuntimeRepository(crypto.devicePublicKeyPem, crypto.devicePublicKeyFingerprint, 'device-key-v1', now);
    const authenticator = new DeviceRequestAuthenticator(
      new CompactTokenVerifier(crypto.provider), new Ed25519DeviceSignatureVerifier(), repository,
      new InMemoryRequestReplayStore(() => now),
      { issuer: 'universal-license-server', requestMaxSkewSeconds: 300, replayTtlSeconds: 300 }, () => now,
    );
    const body = makeVerifyBody(crypto.artifacts, now.toISOString());
    const input = {
      path: '/api/v1/licenses/verify' as const,
      productCode: 'demo-product', clientVersion: body.client_version, timestamp: body.timestamp,
      clientNonce: body.client_nonce, deviceId: runtimeIds.deviceId, deviceKeyId: 'device-key-v1',
      signature: signRuntimeRequest({ path: '/api/v1/licenses/verify', body, privateKey: crypto.devicePair.privateKey }),
      body, deviceCertificate: body.device_certificate, licenseToken: body.license_token,
    };
    const authenticated = await authenticator.authenticate(input);
    await expect(authenticator.assertNotReplayed(authenticated)).resolves.toBeUndefined();
    await expect(authenticator.assertNotReplayed(authenticated)).rejects.toMatchObject({ code: 'REPLAY_DETECTED' });
  });

  it('rejects a wrong current-request signature', async () => {
    const crypto = await createRuntimeCrypto(now);
    const repository = new FakeLicenseRuntimeRepository(crypto.devicePublicKeyPem, crypto.devicePublicKeyFingerprint, 'device-key-v1', now);
    const authenticator = new DeviceRequestAuthenticator(
      new CompactTokenVerifier(crypto.provider), new Ed25519DeviceSignatureVerifier(), repository,
      new InMemoryRequestReplayStore(() => now),
      { issuer: 'universal-license-server', requestMaxSkewSeconds: 300, replayTtlSeconds: 300 }, () => now,
    );
    const body = makeVerifyBody(crypto.artifacts, now.toISOString());
    await expect(authenticator.authenticate({
      path: '/api/v1/licenses/verify', productCode: 'demo-product', clientVersion: body.client_version,
      timestamp: body.timestamp, clientNonce: body.client_nonce, deviceId: runtimeIds.deviceId,
      deviceKeyId: 'device-key-v1', signature: Buffer.alloc(64).toString('base64url'), body,
      deviceCertificate: body.device_certificate, licenseToken: body.license_token,
    })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
  });
});

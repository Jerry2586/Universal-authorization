import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Ed25519DeviceSignatureVerifier, activationSigningPayload, type ActivationSignatureBody } from '../src/modules/cryptography/ed25519-device-signature-verifier.js';
import { Ed25519FileSigningKeyProvider } from '../src/modules/cryptography/ed25519-file-signing-key-provider.js';
import { CompactTokenIssuer } from '../src/modules/cryptography/compact-token-issuer.js';

describe('fourth-stage cryptography', () => {
  it('verifies device proof-of-possession and rejects changed bodies', () => {
    const pair = generateKeyPairSync('ed25519');
    const body = activationBody(pair.publicKey.export({ type: 'spki', format: 'pem' }).toString());
    const signature = sign(null, Buffer.from(activationSigningPayload(body, 'device-key-v1')), pair.privateKey).toString('base64url');
    const verifier = new Ed25519DeviceSignatureVerifier();

    expect(verifier.verifyActivation({ body, deviceKeyId: 'device-key-v1', signature }).publicKeyFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(() => verifier.verifyActivation({ body: { ...body, client_version: '9.9.9' }, deviceKeyId: 'device-key-v1', signature }))
      .toThrow('设备签名验证失败');
  });

  it('issues compact Ed25519 license and device tokens that can be verified', async () => {
    const pair = generateKeyPairSync('ed25519');
    const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const provider = new Ed25519FileSigningKeyProvider('test-signing-v1', Buffer.from(privatePem).toString('base64'));
    const issuer = new CompactTokenIssuer(provider);
    const issuedAt = new Date('2026-08-24T12:00:00.000Z');
    const result = await issuer.issue({
      issuer: 'test-license-server', tenantId: 'tenant', productCode: 'demo-product', licenseId: 'license',
      deviceId: 'device', activationId: 'activation', sessionId: 'session', tokenJti: 'jti',
      licenseType: 'PERPETUAL', licenseStatus: 'ACTIVE', licenseExpiresAt: null, issuedAt,
      tokenExpiresAt: new Date('2026-08-24T12:15:00.000Z'), offlineUntil: new Date('2026-08-25T12:15:00.000Z'),
      certificateExpiresAt: new Date('2026-09-24T12:00:00.000Z'), devicePublicKeyFingerprint: 'a'.repeat(64),
      deviceKeyId: 'device-key-v1', features: [], maxDevices: 1, maxConcurrentSessions: 1,
    });

    expect(result.signingKeyId).toBe('test-signing-v1');
    for (const token of [result.licenseToken, result.deviceCertificate]) {
      const [header, payload, signature] = token.split('.');
      expect(header).toBeDefined(); expect(payload).toBeDefined(); expect(signature).toBeDefined();
      expect(verify(null, Buffer.from(`${header}.${payload}`), pair.publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
    }
    const claims = JSON.parse(Buffer.from(result.licenseToken.split('.')[1]!, 'base64url').toString('utf8'));
    expect(claims).toMatchObject({ aud: 'demo-product', license_id: 'license', device_id: 'device', signing_key_id: 'test-signing-v1' });
  });

  it('fails closed when the server signing key is missing', async () => {
    const provider = new Ed25519FileSigningKeyProvider('missing-key');
    await expect(provider.getActiveKey()).rejects.toMatchObject({ code: 'SIGNING_KEY_NOT_CONFIGURED', statusCode: 503 });
  });
});

function activationBody(publicKey: string): ActivationSignatureBody {
  return {
    product_code: 'demo-product', license_key: 'ULK1-ABCD-EFGH-JKMP-QRST-WXYZ', device_public_key: publicKey,
    device_fingerprint_hash: 'a'.repeat(64), device_name: '测试设备', platform: 'windows', os_version: 'Windows 11',
    client_version: '1.2.0', server_nonce: 's'.repeat(43), client_nonce: 'client-nonce-1234567890',
    timestamp: '2026-08-24T12:00:00.000Z', idempotency_key: 'idem-activation-1234567890',
  };
}


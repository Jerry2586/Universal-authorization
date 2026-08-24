import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CompactTokenVerifier } from '../src/modules/cryptography/compact-token-verifier.js';
import { Ed25519FileSigningKeyProvider } from '../src/modules/cryptography/ed25519-file-signing-key-provider.js';
import { createRuntimeCrypto } from './runtime-test-helpers.js';

const now = new Date('2026-08-24T12:00:00.000Z');

describe('CompactTokenVerifier', () => {
  it('verifies valid device credentials and license tokens', async () => {
    const crypto = await createRuntimeCrypto(now);
    const verifier = new CompactTokenVerifier(crypto.provider);
    await expect(verifier.verifyDeviceCredential(crypto.artifacts.deviceCertificate, options())).resolves.toMatchObject({
      aud: 'demo-product', device_key_id: 'device-key-v1',
    });
    await expect(verifier.verifyLicenseToken(crypto.artifacts.licenseToken, options())).resolves.toMatchObject({
      aud: 'demo-product', session_id: '66666666-6666-4666-8666-666666666666',
    });
  });

  it('rejects a modified payload and an unknown signing key', async () => {
    const crypto = await createRuntimeCrypto(now);
    const verifier = new CompactTokenVerifier(crypto.provider);
    const parts = crypto.artifacts.licenseToken.split('.');
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    claims.device_id = '88888888-8888-4888-8888-888888888888';
    const tampered = `${parts[0]}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${parts[2]}`;
    await expect(verifier.verifyLicenseToken(tampered, options())).rejects.toMatchObject({ code: 'LICENSE_TOKEN_INVALID' });

    const anotherPair = generateKeyPairSync('ed25519');
    const anotherProvider = new Ed25519FileSigningKeyProvider(
      'another-key',
      Buffer.from(anotherPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()).toString('base64'),
    );
    await expect(new CompactTokenVerifier(anotherProvider).verifyLicenseToken(crypto.artifacts.licenseToken, options()))
      .rejects.toMatchObject({ code: 'LICENSE_TOKEN_INVALID' });
  });

  it('rejects expired credentials and tokens with specific error codes', async () => {
    const expiredTokenCrypto = await createRuntimeCrypto(
      new Date('2026-08-24T10:00:00.000Z'),
      new Date('2026-08-24T10:15:00.000Z'),
    );
    await expect(new CompactTokenVerifier(expiredTokenCrypto.provider).verifyLicenseToken(expiredTokenCrypto.artifacts.licenseToken, options()))
      .rejects.toMatchObject({ code: 'LICENSE_TOKEN_EXPIRED' });

    const expiredCredentialCrypto = await createRuntimeCrypto(
      new Date('2026-06-01T10:00:00.000Z'),
      new Date('2026-06-01T10:15:00.000Z'),
    );
    await expect(new CompactTokenVerifier(expiredCredentialCrypto.provider).verifyDeviceCredential(expiredCredentialCrypto.artifacts.deviceCertificate, options()))
      .rejects.toMatchObject({ code: 'DEVICE_CREDENTIAL_EXPIRED' });
  });
});

function options() {
  return { issuer: 'universal-license-server', audience: 'demo-product', now };
}


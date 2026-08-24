import { createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../shared/errors/app-error.js';
import type { SigningKeyProvider } from './signing-key-provider.js';

const commonClaimsSchema = z.object({
  iss: z.string().min(1),
  aud: z.string().min(1),
  tenant_id: z.uuid(),
  license_id: z.uuid(),
  device_id: z.uuid(),
  activation_id: z.uuid(),
  iat: z.number().int().nonnegative(),
  nbf: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  signing_key_id: z.string().min(1),
  protocol_version: z.literal('v1'),
});

const deviceCredentialClaimsSchema = commonClaimsSchema.extend({
  sub: z.uuid(),
  device_public_key_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  device_key_id: z.string().min(1).max(96),
});

const licenseTokenClaimsSchema = commonClaimsSchema.extend({
  sub: z.uuid(),
  session_id: z.uuid(),
  license_type: z.string().min(1).max(24),
  license_status: z.string().min(1).max(24),
  license_expires_at: z.string().datetime({ offset: true }).nullable(),
  features: z.array(z.record(z.string(), z.unknown())),
  usage_limits: z.object({
    max_devices: z.number().int().positive(),
    max_concurrent_sessions: z.number().int().positive(),
  }),
  offline_until: z.string().datetime({ offset: true }).nullable(),
  jti: z.uuid(),
});

export type DeviceCredentialClaims = z.infer<typeof deviceCredentialClaimsSchema>;
export type LicenseTokenClaims = z.infer<typeof licenseTokenClaimsSchema>;

export interface CompactTokenVerificationOptions {
  issuer: string;
  audience: string;
  now: Date;
}

export class CompactTokenVerifier {
  public constructor(private readonly provider: SigningKeyProvider) {}

  public async verifyDeviceCredential(token: string, options: CompactTokenVerificationOptions): Promise<DeviceCredentialClaims> {
    return this.verifyToken(token, 'UDC+JWT', deviceCredentialClaimsSchema, options, 'DEVICE_CREDENTIAL');
  }

  public async verifyLicenseToken(token: string, options: CompactTokenVerificationOptions): Promise<LicenseTokenClaims> {
    return this.verifyToken(token, 'ULT+JWT', licenseTokenClaimsSchema, options, 'LICENSE_TOKEN');
  }

  private async verifyToken<T>(
    token: string,
    expectedType: 'UDC+JWT' | 'ULT+JWT',
    schema: z.ZodType<T>,
    options: CompactTokenVerificationOptions,
    errorPrefix: 'DEVICE_CREDENTIAL' | 'LICENSE_TOKEN',
  ): Promise<T> {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) throw invalidToken(errorPrefix);
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

    let header: unknown;
    let payload: unknown;
    let signature: Buffer;
    try {
      header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
      payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
      signature = Buffer.from(encodedSignature, 'base64url');
    } catch {
      throw invalidToken(errorPrefix);
    }

    const parsedHeader = z.object({ alg: z.literal('EdDSA'), kid: z.string().min(1), typ: z.literal(expectedType) }).safeParse(header);
    if (!parsedHeader.success || signature.length !== 64) throw invalidToken(errorPrefix);

    const keys = await this.provider.getVerificationKeys();
    const key = keys.find((candidate) => candidate.keyId === parsedHeader.data.kid && candidate.algorithm === 'Ed25519');
    if (key === undefined) throw invalidToken(errorPrefix);

    let publicKey;
    try {
      publicKey = createPublicKey(key.publicKeyPem);
    } catch {
      throw invalidToken(errorPrefix);
    }
    if (publicKey.asymmetricKeyType !== 'ed25519') throw invalidToken(errorPrefix);
    if (!verify(null, Buffer.from(`${encodedHeader}.${encodedPayload}`, 'utf8'), publicKey, signature)) {
      throw invalidToken(errorPrefix);
    }

    const parsedClaims = schema.safeParse(payload);
    if (!parsedClaims.success) throw invalidToken(errorPrefix);
    const claims = parsedClaims.data as T & { iss: string; aud: string; nbf: number; exp: number; signing_key_id: string };
    if (claims.signing_key_id !== parsedHeader.data.kid || claims.iss !== options.issuer || claims.aud !== options.audience) {
      throw invalidToken(errorPrefix);
    }

    const nowEpoch = Math.floor(options.now.getTime() / 1_000);
    if (claims.nbf > nowEpoch) throw invalidToken(errorPrefix);
    if (claims.exp <= nowEpoch) {
      throw new AppError({ code: `${errorPrefix}_EXPIRED`, message: errorPrefix === 'DEVICE_CREDENTIAL' ? '设备凭证已过期' : '授权令牌已过期', statusCode: 401 });
    }
    return parsedClaims.data;
  }
}

function invalidToken(prefix: 'DEVICE_CREDENTIAL' | 'LICENSE_TOKEN'): AppError {
  return new AppError({
    code: `${prefix}_INVALID`,
    message: prefix === 'DEVICE_CREDENTIAL' ? '设备凭证无效' : '授权令牌无效',
    statusCode: 401,
  });
}

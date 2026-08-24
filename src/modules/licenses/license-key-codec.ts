import { createHmac, randomBytes } from 'node:crypto';
import { AppError } from '../../shared/errors/app-error.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface EncodedLicenseKey {
  plainText: string;
  hash: string;
  prefix: string;
  suffix: string;
}

export interface LicenseKeyCodec {
  generate(): EncodedLicenseKey;
  hash(plainText: string): string;
}

export class HmacLicenseKeyCodec implements LicenseKeyCodec {
  public constructor(private readonly pepper?: string) {}

  public generate(): EncodedLicenseKey {
    this.requirePepper();
    const bytes = randomBytes(20);
    let randomPart = '';
    for (const byte of bytes) randomPart += ALPHABET[byte & 31];
    const groups = randomPart.match(/.{4}/g);
    if (groups === null) throw new Error('Failed to format generated license key');
    const plainText = `ULK1-${groups.join('-')}`;
    return {
      plainText,
      hash: this.hash(plainText),
      prefix: plainText.slice(0, 9),
      suffix: plainText.slice(-4),
    };
  }

  public hash(plainText: string): string {
    const pepper = this.requirePepper();
    const normalized = plainText.trim().toUpperCase();
    return `hmac-sha256:${createHmac('sha256', pepper).update(normalized).digest('hex')}`;
  }

  private requirePepper(): string {
    if (this.pepper === undefined || this.pepper.length < 32) {
      throw new AppError({
        code: 'LICENSE_KEY_PEPPER_NOT_CONFIGURED',
        message: 'Key 摘要密钥尚未安全配置',
        statusCode: 503,
      });
    }
    return this.pepper;
  }
}

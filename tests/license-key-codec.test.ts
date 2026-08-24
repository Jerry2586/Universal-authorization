import { describe, expect, it } from 'vitest';
import { HmacLicenseKeyCodec } from '../src/modules/licenses/license-key-codec.js';

describe('HmacLicenseKeyCodec', () => {
  it('generates a readable high-entropy Key and stores only a keyed digest', () => {
    const codec = new HmacLicenseKeyCodec('test-pepper-that-is-longer-than-32-characters');
    const generated = codec.generate();

    expect(generated.plainText).toMatch(/^ULK1-[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){4}$/);
    expect(generated.hash).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
    expect(generated.hash).not.toContain(generated.plainText);
    expect(generated.prefix).toBe(generated.plainText.slice(0, 9));
    expect(generated.suffix).toBe(generated.plainText.slice(-4));
  });

  it('normalizes Key text before hashing', () => {
    const codec = new HmacLicenseKeyCodec('test-pepper-that-is-longer-than-32-characters');
    expect(codec.hash(' ulk1-abcd-efgh-jkmn-pqrs-tuvw ')).toBe(
      codec.hash('ULK1-ABCD-EFGH-JKMN-PQRS-TUVW'),
    );
  });

  it('refuses to generate Keys without a configured pepper', () => {
    const codec = new HmacLicenseKeyCodec();
    expect(() => codec.generate()).toThrowError(/尚未安全配置/);
  });
});

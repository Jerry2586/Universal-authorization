import { describe, expect, it } from 'vitest';
import {
  canLicenseActivate,
  effectiveLicenseStatus,
  type LicenseKey,
} from '../src/modules/licenses/domain/license-key.js';

function createLicense(
  overrides: Partial<LicenseKey> = {},
  options: { includeExpiry?: boolean } = {},
): LicenseKey {
  const base: LicenseKey = {
    id: 'license-1',
    tenantId: 'tenant-1',
    productId: 'product-1',
    keyHash: 'hashed-key',
    status: 'ACTIVE',
    type: 'FIXED_EXPIRY',
    maxDevices: 1,
    maxConcurrentSessions: 1,
    features: [],
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    ...(options.includeExpiry === false
      ? {}
      : { expiresAt: new Date('2026-09-01T00:00:00.000Z') }),
  };

  return { ...base, ...overrides };
}

describe('license domain rules', () => {
  it('treats a license past its expiration time as expired', () => {
    const license = createLicense();
    const now = new Date('2026-09-01T00:00:00.000Z');

    expect(effectiveLicenseStatus(license, now)).toBe('EXPIRED');
    expect(canLicenseActivate(license, now)).toBe(false);
  });

  it('never allows a revoked license to activate', () => {
    const license = createLicense(
      { status: 'REVOKED' },
      { includeExpiry: false },
    );

    expect(effectiveLicenseStatus(license, new Date())).toBe('REVOKED');
    expect(canLicenseActivate(license, new Date())).toBe(false);
  });

  it('allows created and active licenses when no blocking rule applies', () => {
    const active = createLicense(
      { type: 'PERPETUAL' },
      { includeExpiry: false },
    );
    const created = createLicense(
      { status: 'CREATED', type: 'DURATION' },
      { includeExpiry: false },
    );

    expect(canLicenseActivate(active, new Date('2026-08-24T00:00:00.000Z'))).toBe(true);
    expect(canLicenseActivate(created, new Date('2026-08-24T00:00:00.000Z'))).toBe(true);
  });
});

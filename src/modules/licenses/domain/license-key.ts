export const LICENSE_STATUSES = [
  'CREATED',
  'ACTIVE',
  'SUSPENDED',
  'EXPIRED',
  'REVOKED',
  'DISABLED',
] as const;

export type LicenseStatus = (typeof LICENSE_STATUSES)[number];

export const LICENSE_TYPES = [
  'TRIAL',
  'DURATION',
  'FIXED_EXPIRY',
  'PERPETUAL',
] as const;

export type LicenseType = (typeof LICENSE_TYPES)[number];

export interface FeatureGrant {
  code: string;
  allowed: boolean;
  limits?: Readonly<Record<string, number | string | boolean>>;
  expiresAt?: Date;
}

export interface LicenseKey {
  id: string;
  tenantId: string;
  productId: string;
  keyHash: string;
  status: LicenseStatus;
  type: LicenseType;
  startsAt?: Date;
  expiresAt?: Date;
  maxDevices: number;
  maxConcurrentSessions: number;
  features: readonly FeatureGrant[];
  createdAt: Date;
  activatedAt?: Date;
  revokedAt?: Date;
}

export function effectiveLicenseStatus(license: LicenseKey, now: Date): LicenseStatus {
  if (license.status === 'REVOKED') {
    return 'REVOKED';
  }

  if (license.status === 'DISABLED') {
    return 'DISABLED';
  }

  if (license.status === 'SUSPENDED') {
    return 'SUSPENDED';
  }

  if (license.expiresAt !== undefined && license.expiresAt.getTime() <= now.getTime()) {
    return 'EXPIRED';
  }

  return license.status;
}

export function canLicenseActivate(license: LicenseKey, now: Date): boolean {
  const status = effectiveLicenseStatus(license, now);
  return status === 'CREATED' || status === 'ACTIVE';
}

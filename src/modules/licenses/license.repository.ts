import type { LicenseStatus, LicenseType } from './domain/license-key.js';
import type { LicensePolicy } from '../products/product.repository.js';

export interface LicenseFeatureGrant {
  code: string;
  allowed: boolean;
  limits: Readonly<Record<string, unknown>>;
  expiresAt: Date | null;
}

export interface ManagedLicenseKey {
  id: string;
  tenantId: string;
  productId: string;
  policyId: string | null;
  generationBatchId: string | null;
  keyPrefix: string;
  keySuffix: string;
  status: LicenseStatus;
  licenseType: LicenseType;
  startsAt: Date | null;
  expiresAt: Date | null;
  durationSeconds: number | null;
  maxDevices: number;
  maxConcurrentSessions: number;
  offlineGraceSeconds: number;
  allowSelfUnbind: boolean;
  unbindCooldownSeconds: number;
  metadata: Readonly<Record<string, unknown>>;
  features: readonly LicenseFeatureGrant[];
  createdAt: Date;
  activatedAt: Date | null;
  revokedAt: Date | null;
  updatedAt: Date;
}

export interface LicenseGenerationContext {
  policy: LicensePolicy;
  productStatus: 'ACTIVE' | 'DISABLED';
}

export interface RequestedFeatureGrant {
  code: string;
  allowed: boolean;
  limits: Readonly<Record<string, unknown>>;
  expiresAt?: Date | null;
}

export interface PreparedLicenseKey {
  keyHash: string;
  keyPrefix: string;
  keySuffix: string;
}

export interface CreateLicenseBatchInput {
  tenantId: string;
  productId: string;
  policyId: string;
  licenseType: LicenseType;
  generationBatchId: string;
  createdBy: string;
  preparedKeys: readonly PreparedLicenseKey[];
  durationSeconds: number | null;
  maxDevices: number;
  maxConcurrentSessions: number;
  offlineGraceSeconds: number;
  allowSelfUnbind: boolean;
  unbindCooldownSeconds: number;
  metadata: Readonly<Record<string, unknown>>;
  features: readonly RequestedFeatureGrant[];
  expiresAt: Date | null;
}

export interface LicenseListInput {
  tenantId: string;
  productId?: string;
  status?: LicenseStatus;
  limit: number;
  offset: number;
}

export interface LicenseRepository {
  getGenerationContext(tenantId: string, productId: string, policyId: string): Promise<LicenseGenerationContext | null>;
  createBatch(input: CreateLicenseBatchInput): Promise<readonly ManagedLicenseKey[]>;
  findById(tenantId: string, licenseId: string): Promise<ManagedLicenseKey | null>;
  list(input: LicenseListInput): Promise<readonly ManagedLicenseKey[]>;
  changeStatus(
    tenantId: string,
    licenseId: string,
    expected: readonly LicenseStatus[],
    status: LicenseStatus,
    changes?: { suspendedFromStatus?: LicenseStatus | null; revokedAt?: Date | null; expiresAt?: Date | null },
  ): Promise<ManagedLicenseKey | null>;
}




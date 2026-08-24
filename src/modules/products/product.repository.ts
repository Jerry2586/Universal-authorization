import type { ProductStatus } from './domain/product.js';
import type { LicenseType } from '../licenses/domain/license-key.js';
import type { PageResult } from '../../shared/pagination/page-result.js';

export type ProductVersionStatus = 'ACTIVE' | 'BLOCKED' | 'DEPRECATED';
export type FeatureDefinitionStatus = 'ACTIVE' | 'DISABLED';
export type LicensePolicyStatus = 'ACTIVE' | 'DISABLED';

export interface ManagedProduct {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  description: string | null;
  status: ProductStatus;
  minimumClientVersion: string | null;
  recommendedClientVersion: string | null;
  forceUpdateVersion: string | null;
  settings: Readonly<Record<string, unknown>>;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProductVersion {
  id: string;
  productId: string;
  version: string;
  status: ProductVersionStatus;
  forceUpdate: boolean;
  releaseNotes: string | null;
  releasedAt: Date | null;
  createdAt: Date;
}

export interface FeatureDefinition {
  id: string;
  productId: string;
  code: string;
  name: string;
  description: string | null;
  status: FeatureDefinitionStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface LicensePolicy {
  id: string;
  tenantId: string;
  productId: string | null;
  code: string;
  name: string;
  licenseType: LicenseType;
  durationSeconds: number | null;
  maxDevices: number;
  maxConcurrentSessions: number;
  offlineGraceSeconds: number;
  allowSelfUnbind: boolean;
  unbindCooldownSeconds: number;
  rules: Readonly<Record<string, unknown>>;
  status: LicensePolicyStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface PageInput {
  limit: number;
  offset: number;
}

export interface CreateProductInput {
  tenantId: string;
  code: string;
  name: string;
  description?: string | null;
  status?: ProductStatus;
  minimumClientVersion?: string | null;
  recommendedClientVersion?: string | null;
  forceUpdateVersion?: string | null;
  settings?: Readonly<Record<string, unknown>>;
}

export type UpdateProductInput = Partial<Omit<CreateProductInput, 'tenantId' | 'code'>>;

export interface CreateProductVersionInput {
  tenantId: string;
  productId: string;
  version: string;
  status: ProductVersionStatus;
  forceUpdate: boolean;
  releaseNotes?: string | null;
  releasedAt?: Date | null;
}

export type UpdateProductVersionInput = Partial<
  Pick<CreateProductVersionInput, 'status' | 'forceUpdate' | 'releaseNotes' | 'releasedAt'>
>;

export interface CreateFeatureDefinitionInput {
  tenantId: string;
  productId: string;
  code: string;
  name: string;
  description?: string | null;
  status: FeatureDefinitionStatus;
}

export type UpdateFeatureDefinitionInput = Partial<
  Pick<CreateFeatureDefinitionInput, 'name' | 'description' | 'status'>
>;

export interface CreateLicensePolicyInput {
  tenantId: string;
  productId?: string | null;
  code: string;
  name: string;
  licenseType: LicenseType;
  durationSeconds?: number | null;
  maxDevices: number;
  maxConcurrentSessions: number;
  offlineGraceSeconds: number;
  allowSelfUnbind: boolean;
  unbindCooldownSeconds: number;
  rules: Readonly<Record<string, unknown>>;
  status: LicensePolicyStatus;
}

export type UpdateLicensePolicyInput = Partial<
  Omit<CreateLicensePolicyInput, 'tenantId' | 'code'>
>;

export interface ProductRepository {
  createProduct(input: CreateProductInput): Promise<ManagedProduct>;
  findProduct(tenantId: string, productId: string): Promise<ManagedProduct | null>;
  listProducts(tenantId: string, page: PageInput): Promise<PageResult<ManagedProduct>>;
  updateProduct(tenantId: string, productId: string, input: UpdateProductInput): Promise<ManagedProduct | null>;

  createVersion(input: CreateProductVersionInput): Promise<ProductVersion>;
  listVersions(tenantId: string, productId: string): Promise<readonly ProductVersion[]>;
  updateVersion(tenantId: string, productId: string, versionId: string, input: UpdateProductVersionInput): Promise<ProductVersion | null>;

  createFeature(input: CreateFeatureDefinitionInput): Promise<FeatureDefinition>;
  listFeatures(tenantId: string, productId: string): Promise<readonly FeatureDefinition[]>;
  updateFeature(tenantId: string, productId: string, featureId: string, input: UpdateFeatureDefinitionInput): Promise<FeatureDefinition | null>;

  createPolicy(input: CreateLicensePolicyInput): Promise<LicensePolicy>;
  findPolicy(tenantId: string, policyId: string): Promise<LicensePolicy | null>;
  listPolicies(tenantId: string, productId: string | undefined, page: PageInput): Promise<PageResult<LicensePolicy>>;
  updatePolicy(tenantId: string, policyId: string, input: UpdateLicensePolicyInput): Promise<LicensePolicy | null>;
}

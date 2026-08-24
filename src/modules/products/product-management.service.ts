import { AppError } from '../../shared/errors/app-error.js';
import type { AuditLogPort } from '../audit/audit-log.port.js';
import type { PageResult } from '../../shared/pagination/page-result.js';
import type { ManagementRequestContext } from '../identity/admin-principal.js';
import type {
  CreateFeatureDefinitionInput,
  CreateLicensePolicyInput,
  CreateProductInput,
  CreateProductVersionInput,
  FeatureDefinition,
  LicensePolicy,
  ManagedProduct,
  PageInput,
  ProductRepository,
  ProductVersion,
  UpdateFeatureDefinitionInput,
  UpdateLicensePolicyInput,
  UpdateProductInput,
  UpdateProductVersionInput,
} from './product.repository.js';

export class ProductManagementService {
  public constructor(
    private readonly repository: ProductRepository,
    private readonly auditLog: AuditLogPort,
  ) {}

  public async createProduct(
    context: ManagementRequestContext,
    input: Omit<CreateProductInput, 'tenantId'>,
  ): Promise<ManagedProduct> {
    const product = await this.repository.createProduct({ ...input, tenantId: context.tenantId });
    await this.audit(context, 'product.create', 'PRODUCT', product.id, undefined, product);
    return product;
  }

  public async getProduct(context: ManagementRequestContext, productId: string): Promise<ManagedProduct> {
    return this.requireProduct(context.tenantId, productId);
  }

  public async listProducts(context: ManagementRequestContext, page: PageInput): Promise<PageResult<ManagedProduct>> {
    return this.repository.listProducts(context.tenantId, page);
  }

  public async updateProduct(
    context: ManagementRequestContext,
    productId: string,
    input: UpdateProductInput,
  ): Promise<ManagedProduct> {
    const before = await this.requireProduct(context.tenantId, productId);
    const after = await this.repository.updateProduct(context.tenantId, productId, input);
    if (after === null) throw this.notFound('PRODUCT_NOT_FOUND', '产品不存在');
    await this.audit(context, 'product.update', 'PRODUCT', productId, before, after);
    return after;
  }

  public async createVersion(
    context: ManagementRequestContext,
    productId: string,
    input: Omit<CreateProductVersionInput, 'tenantId' | 'productId'>,
  ): Promise<ProductVersion> {
    await this.requireProduct(context.tenantId, productId);
    const version = await this.repository.createVersion({ ...input, tenantId: context.tenantId, productId });
    await this.audit(context, 'product-version.create', 'PRODUCT_VERSION', version.id, undefined, version);
    return version;
  }

  public async listVersions(context: ManagementRequestContext, productId: string): Promise<readonly ProductVersion[]> {
    await this.requireProduct(context.tenantId, productId);
    return this.repository.listVersions(context.tenantId, productId);
  }

  public async updateVersion(
    context: ManagementRequestContext,
    productId: string,
    versionId: string,
    input: UpdateProductVersionInput,
  ): Promise<ProductVersion> {
    await this.requireProduct(context.tenantId, productId);
    const after = await this.repository.updateVersion(context.tenantId, productId, versionId, input);
    if (after === null) throw this.notFound('PRODUCT_VERSION_NOT_FOUND', '产品版本不存在');
    await this.audit(context, 'product-version.update', 'PRODUCT_VERSION', versionId, undefined, after);
    return after;
  }

  public async createFeature(
    context: ManagementRequestContext,
    productId: string,
    input: Omit<CreateFeatureDefinitionInput, 'tenantId' | 'productId'>,
  ): Promise<FeatureDefinition> {
    await this.requireProduct(context.tenantId, productId);
    const feature = await this.repository.createFeature({ ...input, tenantId: context.tenantId, productId });
    await this.audit(context, 'feature.create', 'FEATURE_DEFINITION', feature.id, undefined, feature);
    return feature;
  }

  public async listFeatures(context: ManagementRequestContext, productId: string): Promise<readonly FeatureDefinition[]> {
    await this.requireProduct(context.tenantId, productId);
    return this.repository.listFeatures(context.tenantId, productId);
  }

  public async updateFeature(
    context: ManagementRequestContext,
    productId: string,
    featureId: string,
    input: UpdateFeatureDefinitionInput,
  ): Promise<FeatureDefinition> {
    await this.requireProduct(context.tenantId, productId);
    const after = await this.repository.updateFeature(context.tenantId, productId, featureId, input);
    if (after === null) throw this.notFound('FEATURE_NOT_FOUND', '功能定义不存在');
    await this.audit(context, 'feature.update', 'FEATURE_DEFINITION', featureId, undefined, after);
    return after;
  }

  public async createPolicy(
    context: ManagementRequestContext,
    input: Omit<CreateLicensePolicyInput, 'tenantId'>,
    now = new Date(),
  ): Promise<LicensePolicy> {
    this.validatePolicy(input, now);
    if (input.productId !== undefined && input.productId !== null) {
      await this.requireProduct(context.tenantId, input.productId);
    }
    const policy = await this.repository.createPolicy({ ...input, tenantId: context.tenantId });
    await this.audit(context, 'license-policy.create', 'LICENSE_POLICY', policy.id, undefined, policy);
    return policy;
  }

  public async listPolicies(
    context: ManagementRequestContext,
    productId: string | undefined,
    page: PageInput,
  ): Promise<PageResult<LicensePolicy>> {
    if (productId !== undefined) await this.requireProduct(context.tenantId, productId);
    return this.repository.listPolicies(context.tenantId, productId, page);
  }

  public async updatePolicy(
    context: ManagementRequestContext,
    policyId: string,
    input: UpdateLicensePolicyInput,
    now = new Date(),
  ): Promise<LicensePolicy> {
    const before = await this.repository.findPolicy(context.tenantId, policyId);
    if (before === null) throw this.notFound('LICENSE_POLICY_NOT_FOUND', '授权策略不存在');
    const merged: CreateLicensePolicyInput = {
      tenantId: context.tenantId,
      productId: input.productId === undefined ? before.productId : input.productId,
      code: before.code,
      name: input.name ?? before.name,
      licenseType: input.licenseType ?? before.licenseType,
      durationSeconds: input.durationSeconds === undefined ? before.durationSeconds : input.durationSeconds,
      maxDevices: input.maxDevices ?? before.maxDevices,
      maxConcurrentSessions: input.maxConcurrentSessions ?? before.maxConcurrentSessions,
      offlineGraceSeconds: input.offlineGraceSeconds ?? before.offlineGraceSeconds,
      allowSelfUnbind: input.allowSelfUnbind ?? before.allowSelfUnbind,
      unbindCooldownSeconds: input.unbindCooldownSeconds ?? before.unbindCooldownSeconds,
      rules: input.rules ?? before.rules,
      status: input.status ?? before.status,
    };
    this.validatePolicy(merged, now);
    if (merged.productId !== undefined && merged.productId !== null) {
      await this.requireProduct(context.tenantId, merged.productId);
    }
    const after = await this.repository.updatePolicy(context.tenantId, policyId, input);
    if (after === null) throw this.notFound('LICENSE_POLICY_NOT_FOUND', '授权策略不存在');
    await this.audit(context, 'license-policy.update', 'LICENSE_POLICY', policyId, before, after);
    return after;
  }

  private async requireProduct(tenantId: string, productId: string): Promise<ManagedProduct> {
    const product = await this.repository.findProduct(tenantId, productId);
    if (product === null) throw this.notFound('PRODUCT_NOT_FOUND', '产品不存在');
    return product;
  }

  private validatePolicy(
    input: Pick<CreateLicensePolicyInput, 'licenseType' | 'durationSeconds' | 'rules'>,
    now: Date,
  ): void {
    if (input.licenseType === 'TRIAL' || input.licenseType === 'DURATION') {
      if (input.durationSeconds === undefined || input.durationSeconds === null || input.durationSeconds <= 0) {
        throw new AppError({ code: 'INVALID_LICENSE_POLICY', message: '试用或时长授权必须设置有效时长', statusCode: 400 });
      }
      if (input.rules.fixed_expires_at !== undefined && input.rules.fixed_expires_at !== null) {
        throw new AppError({ code: 'INVALID_LICENSE_POLICY', message: '试用或时长授权不能设置固定到期时间', statusCode: 400 });
      }
      return;
    }

    if (input.licenseType === 'FIXED_EXPIRY') {
      if (input.durationSeconds !== undefined && input.durationSeconds !== null) {
        throw new AppError({ code: 'INVALID_LICENSE_POLICY', message: '固定到期授权不能同时设置授权时长', statusCode: 400 });
      }
      const raw = input.rules.fixed_expires_at;
      const expiresAt = typeof raw === 'string' ? new Date(raw) : new Date(Number.NaN);
      if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
        throw new AppError({ code: 'INVALID_LICENSE_POLICY', message: '固定到期策略必须设置未来的 rules.fixed_expires_at', statusCode: 400 });
      }
      return;
    }

    if (input.durationSeconds !== undefined && input.durationSeconds !== null) {
      throw new AppError({ code: 'INVALID_LICENSE_POLICY', message: '永久授权不能设置有效时长', statusCode: 400 });
    }
    if (input.rules.fixed_expires_at !== undefined && input.rules.fixed_expires_at !== null) {
      throw new AppError({ code: 'INVALID_LICENSE_POLICY', message: '永久授权不能设置固定到期时间', statusCode: 400 });
    }
  }

  private async audit(
    context: ManagementRequestContext,
    action: string,
    resourceType: string,
    resourceId: string,
    before?: object,
    after?: object,
  ): Promise<void> {
    await this.auditLog.append({
      actor: { type: 'ADMIN_USER', id: context.principal.userId, tenantId: context.tenantId },
      action,
      resourceType,
      resourceId,
      requestId: context.requestId,
      ...(context.sourceIp === undefined ? {} : { sourceIp: context.sourceIp }),
      ...(context.userAgent === undefined ? {} : { userAgent: context.userAgent }),
      result: 'SUCCESS',
      ...(before === undefined ? {} : { before: before as Readonly<Record<string, unknown>> }),
      ...(after === undefined ? {} : { after: after as Readonly<Record<string, unknown>> }),
      occurredAt: new Date(),
    });
  }

  private notFound(code: string, message: string): AppError {
    return new AppError({ code, message, statusCode: 404 });
  }
}



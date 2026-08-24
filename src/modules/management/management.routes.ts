import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireManagementContext } from '../../shared/management/management-context.js';
import { successResponse } from '../../shared/http/api-response.js';
import type { AdminPrincipalResolver } from '../identity/admin-principal.js';
import { PERMISSIONS } from '../identity/domain/permissions.js';
import type { LicenseManagementService } from '../licenses/license-management.service.js';
import { displayLicenseKey } from '../licenses/license-management.service.js';
import type { ManagedLicenseKey } from '../licenses/license.repository.js';
import type { ProductManagementService } from '../products/product-management.service.js';
import type { FeatureDefinition, LicensePolicy, ManagedProduct, ProductVersion } from '../products/product.repository.js';

export interface ManagementRouteDependencies {
  principalResolver: AdminPrincipalResolver;
  productService: ProductManagementService;
  licenseService: LicenseManagementService;
}

const uuid = z.string().uuid();
const productCode = z.string().min(2).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const versionText = z.string().min(1).max(64).regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
const featureCode = z.string().min(2).max(96).regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/);
const jsonObject = z.record(z.string(), z.unknown());
const pageSchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0) });
const idParams = z.object({ productId: uuid });

const productCreateSchema = z.object({
  code: productCode, name: z.string().min(1).max(120), description: z.string().max(4000).nullable().optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).default('ACTIVE'), minimum_client_version: versionText.nullable().optional(),
  recommended_client_version: versionText.nullable().optional(), force_update_version: versionText.nullable().optional(), settings: jsonObject.default({}),
});
const productUpdateSchema = productCreateSchema.omit({ code: true }).partial().refine((value) => Object.keys(value).length > 0, '至少提供一个修改字段');
const versionCreateSchema = z.object({
  version: versionText, status: z.enum(['ACTIVE', 'BLOCKED', 'DEPRECATED']).default('ACTIVE'), force_update: z.boolean().default(false),
  release_notes: z.string().max(10000).nullable().optional(), released_at: z.coerce.date().nullable().optional(),
});
const versionUpdateSchema = versionCreateSchema.omit({ version: true }).partial().refine((value) => Object.keys(value).length > 0, '至少提供一个修改字段');
const featureCreateSchema = z.object({
  code: featureCode, name: z.string().min(1).max(120), description: z.string().max(4000).nullable().optional(), status: z.enum(['ACTIVE', 'DISABLED']).default('ACTIVE'),
});
const featureUpdateSchema = featureCreateSchema.omit({ code: true }).partial().refine((value) => Object.keys(value).length > 0, '至少提供一个修改字段');
const policyFields = {
  product_id: uuid.nullable().optional(), name: z.string().min(1).max(120), license_type: z.enum(['TRIAL', 'DURATION', 'FIXED_EXPIRY', 'PERPETUAL']),
  duration_seconds: z.number().int().positive().nullable().optional(), max_devices: z.number().int().min(1).max(1000).default(1),
  max_concurrent_sessions: z.number().int().min(1).max(1000).default(1), offline_grace_seconds: z.number().int().min(0).max(31_536_000).default(86400),
  allow_self_unbind: z.boolean().default(false), unbind_cooldown_seconds: z.number().int().min(0).max(31_536_000).default(604800),
  rules: jsonObject.default({}), status: z.enum(['ACTIVE', 'DISABLED']).default('ACTIVE'),
} as const;
const policyCreateSchema = z.object({ code: productCode, ...policyFields });
const policyUpdateSchema = z.object(policyFields).partial().refine((value) => Object.keys(value).length > 0, '至少提供一个修改字段');
const grantSchema = z.object({ code: featureCode, allowed: z.boolean().default(true), limits: jsonObject.default({}), expires_at: z.coerce.date().nullable().optional() });
const generationBase = z.object({
  product_id: uuid, policy_id: uuid, max_devices: z.number().int().min(1).max(1000).optional(), max_concurrent_sessions: z.number().int().min(1).max(1000).optional(),
  metadata: jsonObject.default({}), features: z.array(grantSchema).max(100).default([]),
}).superRefine(noDuplicateFeatures);
const batchGenerationSchema = z.object({
  product_id: uuid, policy_id: uuid, count: z.number().int().min(1).max(500), max_devices: z.number().int().min(1).max(1000).optional(),
  max_concurrent_sessions: z.number().int().min(1).max(1000).optional(), metadata: jsonObject.default({}), features: z.array(grantSchema).max(100).default([]),
}).superRefine(noDuplicateFeatures);

export function registerManagementRoutes(app: FastifyInstance, dependencies: ManagementRouteDependencies): void {
  const readProducts = [PERMISSIONS.PRODUCTS_READ] as const; const writeProducts = [PERMISSIONS.PRODUCTS_WRITE] as const;
  const readLicenses = [PERMISSIONS.LICENSES_READ] as const; const writeLicenses = [PERMISSIONS.LICENSES_WRITE] as const;

  app.post('/admin/v1/products', async (request, reply) => {
    const context = await requireManagementContext(request, dependencies.principalResolver, writeProducts); const body = productCreateSchema.parse(request.body);
    const product = await dependencies.productService.createProduct(context, productInput(body));
    return reply.status(201).send(successResponse(request.id, productResponse(product), '产品创建成功'));
  });
  app.get('/admin/v1/products', async (request) => {
    const context = await requireManagementContext(request, dependencies.principalResolver, readProducts); const page = pageSchema.parse(request.query);
    const products = await dependencies.productService.listProducts(context, page);
    return successResponse(request.id, { items: products.items.map(productResponse), total: products.total, ...page }, '产品查询成功');
  });
  app.get('/admin/v1/products/:productId', async (request) => {
    const context = await requireManagementContext(request, dependencies.principalResolver, readProducts); const params = idParams.parse(request.params);
    return successResponse(request.id, productResponse(await dependencies.productService.getProduct(context, params.productId)), '产品查询成功');
  });
  app.patch('/admin/v1/products/:productId', async (request) => {
    const context = await requireManagementContext(request, dependencies.principalResolver, writeProducts); const params = idParams.parse(request.params);
    const product = await dependencies.productService.updateProduct(context, params.productId, productInput(productUpdateSchema.parse(request.body)));
    return successResponse(request.id, productResponse(product), '产品修改成功');
  });

  app.post('/admin/v1/products/:productId/versions', async (request, reply) => {
    const context = await requireManagementContext(request, dependencies.principalResolver, writeProducts); const params = idParams.parse(request.params);
    const version = await dependencies.productService.createVersion(context, params.productId, versionInput(versionCreateSchema.parse(request.body)));
    return reply.status(201).send(successResponse(request.id, versionResponse(version), '产品版本创建成功'));
  });
  app.get('/admin/v1/products/:productId/versions', async (request) => {
    const context = await requireManagementContext(request, dependencies.principalResolver, readProducts); const params = idParams.parse(request.params);
    const versions = await dependencies.productService.listVersions(context, params.productId);
    return successResponse(request.id, { items: versions.map(versionResponse) }, '产品版本查询成功');
  });
  app.patch('/admin/v1/products/:productId/versions/:versionId', async (request) => {
    const context = await requireManagementContext(request, dependencies.principalResolver, writeProducts);
    const params = z.object({ productId: uuid, versionId: uuid }).parse(request.params);
    const version = await dependencies.productService.updateVersion(context, params.productId, params.versionId, versionInput(versionUpdateSchema.parse(request.body)));
    return successResponse(request.id, versionResponse(version), '产品版本修改成功');
  });

  app.post('/admin/v1/products/:productId/features', async (request, reply) => {
    const context = await requireManagementContext(request, dependencies.principalResolver, writeProducts); const params = idParams.parse(request.params);
    const feature = await dependencies.productService.createFeature(context, params.productId, featureInput(featureCreateSchema.parse(request.body)));
    return reply.status(201).send(successResponse(request.id, featureResponse(feature), '功能定义创建成功'));
  });
  app.get('/admin/v1/products/:productId/features', async (request) => {
    const context = await requireManagementContext(request, dependencies.principalResolver, readProducts); const params = idParams.parse(request.params);
    const features = await dependencies.productService.listFeatures(context, params.productId);
    return successResponse(request.id, { items: features.map(featureResponse) }, '功能定义查询成功');
  });
  app.patch('/admin/v1/products/:productId/features/:featureId', async (request) => {
    const context = await requireManagementContext(request, dependencies.principalResolver, writeProducts);
    const params = z.object({ productId: uuid, featureId: uuid }).parse(request.params);
    const feature = await dependencies.productService.updateFeature(context, params.productId, params.featureId, featureInput(featureUpdateSchema.parse(request.body)));
    return successResponse(request.id, featureResponse(feature), '功能定义修改成功');
  });

  app.post('/admin/v1/license-policies', async (request, reply) => {
    const context = await requireManagementContext(request, dependencies.principalResolver, writeLicenses);
    const policy = await dependencies.productService.createPolicy(context, policyInput(policyCreateSchema.parse(request.body)));
    return reply.status(201).send(successResponse(request.id, policyResponse(policy), '授权策略创建成功'));
  });
  app.get('/admin/v1/license-policies', async (request) => {
    const context = await requireManagementContext(request, dependencies.principalResolver, readLicenses);
    const query = pageSchema.extend({ product_id: uuid.optional() }).parse(request.query);
    const policies = await dependencies.productService.listPolicies(context, query.product_id, query);
    return successResponse(request.id, { items: policies.items.map(policyResponse), total: policies.total, limit: query.limit, offset: query.offset }, '授权策略查询成功');
  });
  app.patch('/admin/v1/license-policies/:policyId', async (request) => {
    const context = await requireManagementContext(request, dependencies.principalResolver, writeLicenses);
    const params = z.object({ policyId: uuid }).parse(request.params);
    const policy = await dependencies.productService.updatePolicy(context, params.policyId, policyInput(policyUpdateSchema.parse(request.body)));
    return successResponse(request.id, policyResponse(policy), '授权策略修改成功');
  });

  app.post('/admin/v1/license-keys', async (request, reply) => {
    const context = await requireManagementContext(request, dependencies.principalResolver, writeLicenses);
    const delivery = await dependencies.licenseService.generate(context, generationInput(generationBase.parse(request.body), 1));
    const item = delivery.items[0]; if (item === undefined) throw new Error('Expected one generated license');
    return reply.status(201).send(successResponse(request.id, { generation_batch_id: delivery.generationBatchId, plain_key: item.plainKey, license: licenseResponse(item.license) }, 'Key 生成成功，请立即安全保存明文'));
  });
  app.post('/admin/v1/license-keys/batch', async (request, reply) => {
    const required = [PERMISSIONS.LICENSES_WRITE, PERMISSIONS.LICENSES_EXPORT] as const;
    const context = await requireManagementContext(request, dependencies.principalResolver, required); const body = batchGenerationSchema.parse(request.body);
    const delivery = await dependencies.licenseService.generate(context, generationInput(body, body.count));
    return reply.status(201).send(successResponse(request.id, { generation_batch_id: delivery.generationBatchId, count: delivery.items.length,
      items: delivery.items.map((item) => ({ plain_key: item.plainKey, license: licenseResponse(item.license) })) }, '批量 Key 生成成功，请立即安全保存全部明文'));
  });
  app.get('/admin/v1/license-keys', async (request) => {
    const context = await requireManagementContext(request, dependencies.principalResolver, readLicenses);
    const query = pageSchema.extend({ product_id: uuid.optional(), status: z.enum(['CREATED','ACTIVE','SUSPENDED','EXPIRED','REVOKED','DISABLED']).optional() }).parse(request.query);
    const page = await dependencies.licenseService.list(context, { ...(query.product_id === undefined ? {} : { productId: query.product_id }),
      ...(query.status === undefined ? {} : { status: query.status }), limit: query.limit, offset: query.offset });
    return successResponse(request.id, { items: page.items.map(licenseResponse), total: page.total, limit: query.limit, offset: query.offset }, 'Key 查询成功');
  });
  app.get('/admin/v1/license-keys/:licenseId', async (request) => {
    const context = await requireManagementContext(request, dependencies.principalResolver, readLicenses); const params = z.object({ licenseId: uuid }).parse(request.params);
    return successResponse(request.id, licenseResponse(await dependencies.licenseService.get(context, params.licenseId)), 'Key 查询成功');
  });
  app.post('/admin/v1/license-keys/:licenseId/suspend', async (request) => licenseAction(request, dependencies, 'suspend'));
  app.post('/admin/v1/license-keys/:licenseId/resume', async (request) => licenseAction(request, dependencies, 'resume'));
  app.post('/admin/v1/license-keys/:licenseId/renew', async (request) => {
    const context = await requireManagementContext(request, dependencies.principalResolver, writeLicenses); const params = z.object({ licenseId: uuid }).parse(request.params);
    const body = z.object({ extend_seconds: z.number().int().positive().optional(), expires_at: z.coerce.date().optional() })
      .refine((value) => (value.extend_seconds === undefined) !== (value.expires_at === undefined), '必须且只能提供一种续期方式').parse(request.body);
    const license = await dependencies.licenseService.renew(context, params.licenseId, { ...(body.extend_seconds === undefined ? {} : { extendSeconds: body.extend_seconds }),
      ...(body.expires_at === undefined ? {} : { expiresAt: body.expires_at }) });
    return successResponse(request.id, licenseResponse(license), 'Key 续期成功');
  });
  app.post('/admin/v1/license-keys/:licenseId/revoke', async (request) => {
    const context = await requireManagementContext(request, dependencies.principalResolver, writeLicenses); const params = z.object({ licenseId: uuid }).parse(request.params);
    const body = z.object({ reason: z.string().min(1).max(1000) }).parse(request.body);
    return successResponse(request.id, licenseResponse(await dependencies.licenseService.revoke(context, params.licenseId, body.reason)), 'Key 已永久吊销');
  });
}

async function licenseAction(request: FastifyRequest, dependencies: ManagementRouteDependencies, action: 'suspend' | 'resume') {
  const context = await requireManagementContext(request, dependencies.principalResolver, [PERMISSIONS.LICENSES_WRITE]);
  const params = z.object({ licenseId: uuid }).parse(request.params);
  const license = action === 'suspend' ? await dependencies.licenseService.suspend(context, params.licenseId) : await dependencies.licenseService.resume(context, params.licenseId);
  return successResponse(request.id, licenseResponse(license), action === 'suspend' ? 'Key 已冻结' : 'Key 已解冻');
}

function noDuplicateFeatures(value: { features: readonly { code: string }[] }, context: z.RefinementCtx): void {
  const codes = value.features.map((feature) => feature.code); if (new Set(codes).size !== codes.length) context.addIssue({ code: 'custom', path: ['features'], message: '功能代码不能重复' });
}
function productInput(body: Record<string, unknown>): any { return { ...(body.code === undefined ? {} : { code: body.code }), ...(body.name === undefined ? {} : { name: body.name }),
  ...(body.description === undefined ? {} : { description: body.description }), ...(body.status === undefined ? {} : { status: body.status }),
  ...(body.minimum_client_version === undefined ? {} : { minimumClientVersion: body.minimum_client_version }),
  ...(body.recommended_client_version === undefined ? {} : { recommendedClientVersion: body.recommended_client_version }),
  ...(body.force_update_version === undefined ? {} : { forceUpdateVersion: body.force_update_version }), ...(body.settings === undefined ? {} : { settings: body.settings }) }; }
function versionInput(body: Record<string, unknown>): any { return { ...(body.version === undefined ? {} : { version: body.version }), ...(body.status === undefined ? {} : { status: body.status }),
  ...(body.force_update === undefined ? {} : { forceUpdate: body.force_update }), ...(body.release_notes === undefined ? {} : { releaseNotes: body.release_notes }),
  ...(body.released_at === undefined ? {} : { releasedAt: body.released_at }) }; }
function featureInput(body: Record<string, unknown>): any { return { ...(body.code === undefined ? {} : { code: body.code }), ...(body.name === undefined ? {} : { name: body.name }),
  ...(body.description === undefined ? {} : { description: body.description }), ...(body.status === undefined ? {} : { status: body.status }) }; }
function policyInput(body: Record<string, unknown>): any { return { ...(body.product_id === undefined ? {} : { productId: body.product_id }), ...(body.code === undefined ? {} : { code: body.code }),
  ...(body.name === undefined ? {} : { name: body.name }), ...(body.license_type === undefined ? {} : { licenseType: body.license_type }),
  ...(body.duration_seconds === undefined ? {} : { durationSeconds: body.duration_seconds }), ...(body.max_devices === undefined ? {} : { maxDevices: body.max_devices }),
  ...(body.max_concurrent_sessions === undefined ? {} : { maxConcurrentSessions: body.max_concurrent_sessions }),
  ...(body.offline_grace_seconds === undefined ? {} : { offlineGraceSeconds: body.offline_grace_seconds }),
  ...(body.allow_self_unbind === undefined ? {} : { allowSelfUnbind: body.allow_self_unbind }),
  ...(body.unbind_cooldown_seconds === undefined ? {} : { unbindCooldownSeconds: body.unbind_cooldown_seconds }),
  ...(body.rules === undefined ? {} : { rules: body.rules }), ...(body.status === undefined ? {} : { status: body.status }) }; }
function generationInput(body: any, count: number): any { return { productId: body.product_id, policyId: body.policy_id, count,
  ...(body.max_devices === undefined ? {} : { maxDevices: body.max_devices }), ...(body.max_concurrent_sessions === undefined ? {} : { maxConcurrentSessions: body.max_concurrent_sessions }),
  metadata: body.metadata, features: body.features.map((feature: any) => ({ code: feature.code, allowed: feature.allowed, limits: feature.limits,
    ...(feature.expires_at === undefined ? {} : { expiresAt: feature.expires_at }) })) }; }
function productResponse(item: ManagedProduct) { return { id:item.id, tenant_id:item.tenantId, code:item.code, name:item.name, description:item.description, status:item.status,
  minimum_client_version:item.minimumClientVersion, recommended_client_version:item.recommendedClientVersion, force_update_version:item.forceUpdateVersion,
  settings:item.settings, created_at:item.createdAt.toISOString(), updated_at:item.updatedAt.toISOString() }; }
function versionResponse(item: ProductVersion) { return { id:item.id, product_id:item.productId, version:item.version, status:item.status, force_update:item.forceUpdate,
  release_notes:item.releaseNotes, released_at:item.releasedAt?.toISOString() ?? null, created_at:item.createdAt.toISOString() }; }
function featureResponse(item: FeatureDefinition) { return { id:item.id, product_id:item.productId, code:item.code, name:item.name, description:item.description,
  status:item.status, created_at:item.createdAt.toISOString(), updated_at:item.updatedAt.toISOString() }; }
function policyResponse(item: LicensePolicy) { return { id:item.id, tenant_id:item.tenantId, product_id:item.productId, code:item.code, name:item.name,
  license_type:item.licenseType, duration_seconds:item.durationSeconds, max_devices:item.maxDevices, max_concurrent_sessions:item.maxConcurrentSessions,
  offline_grace_seconds:item.offlineGraceSeconds, allow_self_unbind:item.allowSelfUnbind, unbind_cooldown_seconds:item.unbindCooldownSeconds,
  rules:item.rules, status:item.status, created_at:item.createdAt.toISOString(), updated_at:item.updatedAt.toISOString() }; }
function licenseResponse(item: ManagedLicenseKey) { return { id:item.id, tenant_id:item.tenantId, product_id:item.productId, policy_id:item.policyId,
  generation_batch_id:item.generationBatchId, display_key:displayLicenseKey(item), status:item.status, license_type:item.licenseType,
  starts_at:item.startsAt?.toISOString() ?? null, expires_at:item.expiresAt?.toISOString() ?? null, duration_seconds:item.durationSeconds, max_devices:item.maxDevices,
  max_concurrent_sessions:item.maxConcurrentSessions, offline_grace_seconds:item.offlineGraceSeconds, allow_self_unbind:item.allowSelfUnbind,
  unbind_cooldown_seconds:item.unbindCooldownSeconds, metadata:item.metadata, features:item.features.map((feature) => ({ code:feature.code, allowed:feature.allowed,
    limits:feature.limits, expires_at:feature.expiresAt?.toISOString() ?? null })), created_at:item.createdAt.toISOString(),
  activated_at:item.activatedAt?.toISOString() ?? null, revoked_at:item.revokedAt?.toISOString() ?? null, updated_at:item.updatedAt.toISOString() }; }


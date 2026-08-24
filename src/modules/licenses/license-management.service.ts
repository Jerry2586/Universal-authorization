import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors/app-error.js';
import type { AuditLogPort } from '../audit/audit-log.port.js';
import type { PageResult } from '../../shared/pagination/page-result.js';
import type { ManagementRequestContext } from '../identity/admin-principal.js';
import type { LicenseStatus } from './domain/license-key.js';
import type { LicenseKeyCodec } from './license-key-codec.js';
import type {
  LicenseListInput,
  LicenseRepository,
  ManagedLicenseKey,
  RequestedFeatureGrant,
} from './license.repository.js';

export interface GenerateLicenseInput {
  productId: string;
  policyId: string;
  count: number;
  maxDevices?: number;
  maxConcurrentSessions?: number;
  metadata: Readonly<Record<string, unknown>>;
  features: readonly RequestedFeatureGrant[];
}

export interface GeneratedLicenseDelivery {
  generationBatchId: string;
  items: readonly { plainKey: string; license: ManagedLicenseKey }[];
}

export class LicenseManagementService {
  public constructor(
    private readonly repository: LicenseRepository,
    private readonly codec: LicenseKeyCodec,
    private readonly auditLog: AuditLogPort,
  ) {}

  public async generate(
    context: ManagementRequestContext,
    input: GenerateLicenseInput,
  ): Promise<GeneratedLicenseDelivery> {
    if (!Number.isInteger(input.count) || input.count < 1 || input.count > 500) {
      throw new AppError({ code: 'INVALID_BATCH_SIZE', message: 'Key 生成数量必须在 1 到 500 之间', statusCode: 400 });
    }

    const generation = await this.repository.getGenerationContext(context.tenantId, input.productId, input.policyId);
    if (generation === null) {
      throw new AppError({ code: 'LICENSE_POLICY_NOT_FOUND', message: '产品或授权策略不存在', statusCode: 404 });
    }
    if (generation.productStatus !== 'ACTIVE') {
      throw new AppError({ code: 'PRODUCT_DISABLED', message: '产品已停用', statusCode: 409 });
    }
    if (generation.policy.status !== 'ACTIVE') {
      throw new AppError({ code: 'LICENSE_POLICY_DISABLED', message: '授权策略已停用', statusCode: 409 });
    }

    const maxDevices = input.maxDevices ?? generation.policy.maxDevices;
    const maxConcurrentSessions = input.maxConcurrentSessions ?? generation.policy.maxConcurrentSessions;
    if (maxDevices < 1 || maxConcurrentSessions < 1) {
      throw new AppError({ code: 'INVALID_LICENSE_LIMITS', message: '设备数和并发数必须大于 0', statusCode: 400 });
    }

    const generated = Array.from({ length: input.count }, () => this.codec.generate());
    const generationBatchId = randomUUID();
    const expiresAt = this.fixedExpiry(generation.policy.licenseType, generation.policy.rules, new Date());
    const metadata = input.metadata;

    const licenses = await this.repository.createBatch({
      tenantId: context.tenantId,
      productId: input.productId,
      policyId: input.policyId,
      licenseType: generation.policy.licenseType,
      generationBatchId,
      createdBy: context.principal.userId,
      preparedKeys: generated.map((item) => ({ keyHash: item.hash, keyPrefix: item.prefix, keySuffix: item.suffix })),
      durationSeconds: generation.policy.durationSeconds,
      maxDevices,
      maxConcurrentSessions,
      offlineGraceSeconds: generation.policy.offlineGraceSeconds,
      allowSelfUnbind: generation.policy.allowSelfUnbind,
      unbindCooldownSeconds: generation.policy.unbindCooldownSeconds,
      metadata,
      features: input.features,
      expiresAt,
    });

    if (licenses.length !== generated.length) {
      throw new AppError({ code: 'LICENSE_GENERATION_INCOMPLETE', message: 'Key 生成结果不完整，请联系管理员核查', statusCode: 500 });
    }

    await this.auditLog.append({
      actor: { type: 'ADMIN_USER', id: context.principal.userId, tenantId: context.tenantId },
      action: input.count === 1 ? 'license-key.generate' : 'license-key.generate-batch',
      resourceType: 'LICENSE_KEY_BATCH',
      resourceId: generationBatchId,
      requestId: context.requestId,
      ...(context.sourceIp === undefined ? {} : { sourceIp: context.sourceIp }),
      ...(context.userAgent === undefined ? {} : { userAgent: context.userAgent }),
      result: 'SUCCESS',
      after: {
        count: licenses.length,
        product_id: input.productId,
        policy_id: input.policyId,
        display_keys: licenses.map(displayLicenseKey),
      },
      occurredAt: new Date(),
    });

    return {
      generationBatchId,
      items: licenses.map((license, index) => ({
        plainKey: generated[index]?.plainText ?? '',
        license,
      })),
    };
  }

  public async get(context: ManagementRequestContext, licenseId: string): Promise<ManagedLicenseKey> {
    return this.requireLicense(context.tenantId, licenseId);
  }

  public async list(context: ManagementRequestContext, input: Omit<LicenseListInput, 'tenantId'>): Promise<PageResult<ManagedLicenseKey>> {
    return this.repository.list({ ...input, tenantId: context.tenantId });
  }

  public async suspend(context: ManagementRequestContext, licenseId: string): Promise<ManagedLicenseKey> {
    const before = await this.requireLicense(context.tenantId, licenseId);
    if (before.status !== 'ACTIVE') throw this.transitionError(before.status, 'SUSPENDED');
    const after = await this.repository.changeStatus(context.tenantId, licenseId, ['ACTIVE'], 'SUSPENDED', { suspendedFromStatus: 'ACTIVE' });
    if (after === null) throw this.concurrentChange();
    await this.auditStatus(context, 'license-key.suspend', before, after);
    return after;
  }

  public async resume(context: ManagementRequestContext, licenseId: string, now = new Date()): Promise<ManagedLicenseKey> {
    const before = await this.requireLicense(context.tenantId, licenseId);
    if (before.status !== 'SUSPENDED') throw this.transitionError(before.status, 'ACTIVE');
    const nextStatus: LicenseStatus = before.expiresAt !== null && before.expiresAt.getTime() <= now.getTime() ? 'EXPIRED' : 'ACTIVE';
    const after = await this.repository.changeStatus(context.tenantId, licenseId, ['SUSPENDED'], nextStatus, { suspendedFromStatus: null });
    if (after === null) throw this.concurrentChange();
    await this.auditStatus(context, 'license-key.resume', before, after);
    return after;
  }

  public async renew(
    context: ManagementRequestContext,
    licenseId: string,
    input: { extendSeconds?: number; expiresAt?: Date },
    now = new Date(),
  ): Promise<ManagedLicenseKey> {
    const before = await this.requireLicense(context.tenantId, licenseId);
    if (before.status !== 'ACTIVE' && before.status !== 'EXPIRED') throw this.transitionError(before.status, 'ACTIVE');
    if (before.licenseType === 'PERPETUAL') {
      throw new AppError({ code: 'LICENSE_RENEWAL_NOT_REQUIRED', message: '永久授权不需要续期', statusCode: 409 });
    }

    let expiresAt: Date;
    if (before.licenseType === 'FIXED_EXPIRY') {
      if (input.expiresAt === undefined || input.expiresAt.getTime() <= now.getTime()) {
        throw new AppError({ code: 'INVALID_RENEWAL', message: '固定到期授权必须设置未来到期时间', statusCode: 400 });
      }
      expiresAt = input.expiresAt;
    } else {
      if (input.extendSeconds === undefined || input.extendSeconds <= 0) {
        throw new AppError({ code: 'INVALID_RENEWAL', message: '时长授权必须提供大于 0 的续期秒数', statusCode: 400 });
      }
      const base = Math.max(now.getTime(), before.expiresAt?.getTime() ?? now.getTime());
      expiresAt = new Date(base + input.extendSeconds * 1_000);
    }

    const after = await this.repository.changeStatus(
      context.tenantId, licenseId, ['ACTIVE', 'EXPIRED'], 'ACTIVE', { expiresAt },
    );
    if (after === null) throw this.concurrentChange();
    await this.auditStatus(context, 'license-key.renew', before, after);
    return after;
  }

  public async revoke(context: ManagementRequestContext, licenseId: string, reason: string, now = new Date()): Promise<ManagedLicenseKey> {
    const before = await this.requireLicense(context.tenantId, licenseId);
    if (before.status === 'REVOKED') {
      throw new AppError({ code: 'LICENSE_REVOKED', message: '授权已经被永久吊销', statusCode: 409 });
    }
    const expected: LicenseStatus[] = ['CREATED', 'ACTIVE', 'SUSPENDED', 'EXPIRED', 'DISABLED'];
    const after = await this.repository.changeStatus(context.tenantId, licenseId, expected, 'REVOKED', { revokedAt: now, suspendedFromStatus: null });
    if (after === null) throw this.concurrentChange();
    await this.auditStatus(context, 'license-key.revoke', before, after, { reason });
    return after;
  }

  private fixedExpiry(type: string, rules: Readonly<Record<string, unknown>>, now: Date): Date | null {
    if (type !== 'FIXED_EXPIRY') return null;
    const raw = rules.fixed_expires_at;
    const date = typeof raw === 'string' ? new Date(raw) : new Date(Number.NaN);
    if (Number.isNaN(date.getTime()) || date.getTime() <= now.getTime()) {
      throw new AppError({ code: 'INVALID_LICENSE_POLICY', message: '固定到期策略缺少有效到期时间', statusCode: 409 });
    }
    return date;
  }

  private async requireLicense(tenantId: string, licenseId: string): Promise<ManagedLicenseKey> {
    const license = await this.repository.findById(tenantId, licenseId);
    if (license === null) throw new AppError({ code: 'LICENSE_NOT_FOUND', message: '授权不存在', statusCode: 404 });
    return license;
  }

  private async auditStatus(
    context: ManagementRequestContext,
    action: string,
    before: ManagedLicenseKey,
    after: ManagedLicenseKey,
    metadata?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.auditLog.append({
      actor: { type: 'ADMIN_USER', id: context.principal.userId, tenantId: context.tenantId },
      action,
      resourceType: 'LICENSE_KEY',
      resourceId: after.id,
      requestId: context.requestId,
      ...(context.sourceIp === undefined ? {} : { sourceIp: context.sourceIp }),
      ...(context.userAgent === undefined ? {} : { userAgent: context.userAgent }),
      result: 'SUCCESS',
      before: { status: before.status, expires_at: before.expiresAt?.toISOString() ?? null, display_key: displayLicenseKey(before) },
      after: { status: after.status, expires_at: after.expiresAt?.toISOString() ?? null, display_key: displayLicenseKey(after) },
      ...(metadata === undefined ? {} : { metadata }),
      occurredAt: new Date(),
    });
  }

  private transitionError(from: LicenseStatus, to: LicenseStatus): AppError {
    return new AppError({ code: 'INVALID_LICENSE_STATUS_TRANSITION', message: `授权状态不能从 ${from} 变为 ${to}`, statusCode: 409 });
  }

  private concurrentChange(): AppError {
    return new AppError({ code: 'LICENSE_STATE_CHANGED', message: '授权状态已被其他请求修改，请刷新后重试', statusCode: 409, retryable: true });
  }
}

export function displayLicenseKey(license: Pick<ManagedLicenseKey, 'keyPrefix' | 'keySuffix'>): string {
  return `${license.keyPrefix}-...-${license.keySuffix}`;
}







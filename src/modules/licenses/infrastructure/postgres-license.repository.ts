import type { PoolClient, QueryResultRow } from 'pg';
import type { PostgresDatabase } from '../../../infrastructure/database/postgres-database.js';
import { AppError } from '../../../shared/errors/app-error.js';
import type { LicensePolicy } from '../../products/product.repository.js';
import type {
  CreateLicenseBatchInput,
  LicenseFeatureGrant,
  LicenseGenerationContext,
  LicenseListInput,
  LicenseRepository,
  ManagedLicenseKey,
} from '../license.repository.js';
import type { LicenseStatus } from '../domain/license-key.js';

interface LicenseRow extends QueryResultRow {
  id: string; tenant_id: string; product_id: string; policy_id: string | null;
  generation_batch_id: string | null; key_prefix: string; key_suffix: string;
  status: ManagedLicenseKey['status']; license_type: ManagedLicenseKey['licenseType'];
  starts_at: Date | null; expires_at: Date | null; duration_seconds: string | number | null; max_devices: number;
  max_concurrent_sessions: number; offline_grace_seconds: number; allow_self_unbind: boolean;
  unbind_cooldown_seconds: number; metadata: Record<string, unknown>; created_at: Date;
  activated_at: Date | null; revoked_at: Date | null; updated_at: Date;
}
interface FeatureRow extends QueryResultRow {
  license_key_id: string; code: string; allowed: boolean; limits: Record<string, unknown>; expires_at: Date | null;
}
interface FeatureDefinitionRow extends QueryResultRow { id: string; code: string; }
interface GenerationRow extends QueryResultRow {
  product_status: 'ACTIVE' | 'DISABLED'; id: string; tenant_id: string; product_id: string | null;
  code: string; name: string; license_type: LicensePolicy['licenseType']; duration_seconds: string | number | null;
  max_devices: number; max_concurrent_sessions: number; offline_grace_seconds: number;
  allow_self_unbind: boolean; unbind_cooldown_seconds: number; rules: Record<string, unknown>;
  status: LicensePolicy['status']; created_at: Date; updated_at: Date;
}

export class PostgresLicenseRepository implements LicenseRepository {
  public constructor(private readonly database: PostgresDatabase) {}

  public async getGenerationContext(tenantId: string, productId: string, policyId: string): Promise<LicenseGenerationContext | null> {
    const result = await this.database.query<GenerationRow>(
      `SELECT policy.*, product.status AS product_status
       FROM products product
       JOIN license_policies policy ON policy.tenant_id=product.tenant_id
         AND (policy.product_id IS NULL OR policy.product_id=product.id)
       WHERE product.tenant_id=$1 AND product.id=$2 AND policy.id=$3`,
      [tenantId, productId, policyId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return { productStatus: row.product_status, policy: mapPolicy(row) };
  }

  public async createBatch(input: CreateLicenseBatchInput): Promise<readonly ManagedLicenseKey[]> {
    return this.database.transaction(async (client) => {
      const definitions = await this.loadFeatureDefinitions(client, input.tenantId, input.productId, input.features.map((feature) => feature.code));
      if (definitions.size !== new Set(input.features.map((feature) => feature.code)).size) {
        throw new AppError({ code: 'FEATURE_NOT_FOUND', message: '存在无效或已停用的产品功能', statusCode: 400 });
      }

      const created: LicenseRow[] = [];
      try {
        for (const prepared of input.preparedKeys) {
          const result = await client.query<LicenseRow>(
            `INSERT INTO license_keys (
               tenant_id, product_id, policy_id, generation_batch_id, key_hash, key_prefix, key_suffix,
               status, license_type, starts_at, expires_at, duration_seconds, max_devices, max_concurrent_sessions,
               offline_grace_seconds, allow_self_unbind, unbind_cooldown_seconds, metadata, created_by
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,'CREATED',$8,NULL,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17)
             RETURNING *`,
            [input.tenantId, input.productId, input.policyId, input.generationBatchId,
              prepared.keyHash, prepared.keyPrefix, prepared.keySuffix, input.licenseType, input.expiresAt, input.durationSeconds,
              input.maxDevices, input.maxConcurrentSessions, input.offlineGraceSeconds,
              input.allowSelfUnbind, input.unbindCooldownSeconds, JSON.stringify(input.metadata), input.createdBy],
          );
          const row = result.rows[0];
          if (row === undefined) throw new Error('Failed to create license key');
          created.push(row);

          for (const feature of input.features) {
            const featureId = definitions.get(feature.code);
            if (featureId === undefined) continue;
            await client.query(
              `INSERT INTO feature_grants (license_key_id, feature_id, allowed, limits, expires_at)
               VALUES ($1,$2,$3,$4::jsonb,$5)`,
              [row.id, featureId, feature.allowed, JSON.stringify(feature.limits), feature.expiresAt ?? null],
            );
          }
        }
      } catch (error) {
        if (isPgCode(error, '23505')) {
          throw new AppError({ code: 'LICENSE_KEY_COLLISION', message: 'Key 生成发生极低概率冲突，请重新生成', statusCode: 503, retryable: true });
        }
        throw error;
      }

      return created.map((row) => mapLicense(row, input.features.map((feature) => ({
        code: feature.code, allowed: feature.allowed, limits: feature.limits, expiresAt: feature.expiresAt ?? null,
      }))));
    });
  }

  public async findById(tenantId: string, licenseId: string): Promise<ManagedLicenseKey | null> {
    const result = await this.database.query<LicenseRow>('SELECT * FROM license_keys WHERE tenant_id=$1 AND id=$2', [tenantId, licenseId]);
    const row = result.rows[0];
    if (row === undefined) return null;
    const features = await this.loadGrants([row.id]);
    return mapLicense(row, features.get(row.id) ?? []);
  }

  public async list(input: LicenseListInput): Promise<readonly ManagedLicenseKey[]> {
    const result = await this.database.query<LicenseRow>(
      `SELECT * FROM license_keys
       WHERE tenant_id=$1 AND ($2::uuid IS NULL OR product_id=$2) AND ($3::varchar IS NULL OR status=$3)
       ORDER BY created_at DESC, id DESC LIMIT $4 OFFSET $5`,
      [input.tenantId, input.productId ?? null, input.status ?? null, input.limit, input.offset],
    );
    const features = await this.loadGrants(result.rows.map((row) => row.id));
    return result.rows.map((row) => mapLicense(row, features.get(row.id) ?? []));
  }

  public async changeStatus(
    tenantId: string,
    licenseId: string,
    expected: readonly LicenseStatus[],
    status: LicenseStatus,
    changes: { suspendedFromStatus?: LicenseStatus | null; revokedAt?: Date | null; expiresAt?: Date | null } = {},
  ): Promise<ManagedLicenseKey | null> {
    const assignments = ['status=$1'];
    const values: unknown[] = [status];
    if (Object.prototype.hasOwnProperty.call(changes, 'suspendedFromStatus')) {
      values.push(changes.suspendedFromStatus ?? null); assignments.push(`suspended_from_status=$${values.length}`);
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'revokedAt')) {
      values.push(changes.revokedAt ?? null); assignments.push(`revoked_at=$${values.length}`);
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'expiresAt')) {
      values.push(changes.expiresAt ?? null); assignments.push(`expires_at=$${values.length}`);
    }
    values.push(tenantId, licenseId, [...expected]);
    const result = await this.database.query<LicenseRow>(
      `UPDATE license_keys SET ${assignments.join(', ')}
       WHERE tenant_id=$${values.length - 2} AND id=$${values.length - 1} AND status=ANY($${values.length}::varchar[])
       RETURNING *`, values);
    const row = result.rows[0];
    if (row === undefined) return null;
    const features = await this.loadGrants([row.id]);
    return mapLicense(row, features.get(row.id) ?? []);
  }

  private async loadFeatureDefinitions(
    client: PoolClient,
    tenantId: string,
    productId: string,
    codes: readonly string[],
  ): Promise<Map<string, string>> {
    if (codes.length === 0) return new Map();
    const result = await client.query<FeatureDefinitionRow>(
      `SELECT feature.id, feature.code FROM feature_definitions feature
       JOIN products product ON product.id=feature.product_id
       WHERE product.tenant_id=$1 AND product.id=$2 AND feature.status='ACTIVE' AND feature.code=ANY($3::varchar[])`,
      [tenantId, productId, [...new Set(codes)]],
    );
    return new Map(result.rows.map((row) => [row.code, row.id]));
  }

  private async loadGrants(licenseIds: readonly string[]): Promise<Map<string, LicenseFeatureGrant[]>> {
    if (licenseIds.length === 0) return new Map();
    const result = await this.database.query<FeatureRow>(
      `SELECT grant.license_key_id, feature.code, grant.allowed, grant.limits, grant.expires_at
       FROM feature_grants grant JOIN feature_definitions feature ON feature.id=grant.feature_id
       WHERE grant.license_key_id=ANY($1::uuid[]) ORDER BY feature.code`, [[...licenseIds]]);
    const grouped = new Map<string, LicenseFeatureGrant[]>();
    for (const row of result.rows) {
      const items = grouped.get(row.license_key_id) ?? [];
      items.push({ code: row.code, allowed: row.allowed, limits: row.limits, expiresAt: row.expires_at });
      grouped.set(row.license_key_id, items);
    }
    return grouped;
  }
}

function mapLicense(row: LicenseRow, features: readonly LicenseFeatureGrant[]): ManagedLicenseKey {
  return {
    id: row.id, tenantId: row.tenant_id, productId: row.product_id, policyId: row.policy_id,
    generationBatchId: row.generation_batch_id, keyPrefix: row.key_prefix, keySuffix: row.key_suffix,
    status: row.status, licenseType: row.license_type, startsAt: row.starts_at, expiresAt: row.expires_at,
    durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds), maxDevices: row.max_devices, maxConcurrentSessions: row.max_concurrent_sessions,
    offlineGraceSeconds: row.offline_grace_seconds, allowSelfUnbind: row.allow_self_unbind,
    unbindCooldownSeconds: row.unbind_cooldown_seconds, metadata: row.metadata,
    features, createdAt: row.created_at, activatedAt: row.activated_at, revokedAt: row.revoked_at, updatedAt: row.updated_at,
  };
}
function mapPolicy(row: GenerationRow): LicensePolicy {
  return {
    id: row.id, tenantId: row.tenant_id, productId: row.product_id, code: row.code, name: row.name,
    licenseType: row.license_type, durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
    maxDevices: row.max_devices, maxConcurrentSessions: row.max_concurrent_sessions,
    offlineGraceSeconds: row.offline_grace_seconds, allowSelfUnbind: row.allow_self_unbind,
    unbindCooldownSeconds: row.unbind_cooldown_seconds, rules: row.rules, status: row.status,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function isPgCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}




import type { QueryResultRow } from 'pg';
import type { PostgresDatabase } from '../../../infrastructure/database/postgres-database.js';
import { AppError } from '../../../shared/errors/app-error.js';
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
} from '../product.repository.js';

interface ProductRow extends QueryResultRow {
  id: string; tenant_id: string; code: string; name: string; description: string | null;
  status: ManagedProduct['status']; minimum_client_version: string | null;
  recommended_client_version: string | null; force_update_version: string | null;
  settings: Record<string, unknown>; created_at: Date; updated_at: Date;
}
interface VersionRow extends QueryResultRow {
  id: string; product_id: string; version: string; status: ProductVersion['status'];
  force_update: boolean; release_notes: string | null; released_at: Date | null; created_at: Date;
}
interface FeatureRow extends QueryResultRow {
  id: string; product_id: string; code: string; name: string; description: string | null;
  status: FeatureDefinition['status']; created_at: Date; updated_at: Date;
}
interface PolicyRow extends QueryResultRow {
  id: string; tenant_id: string; product_id: string | null; code: string; name: string;
  license_type: LicensePolicy['licenseType']; duration_seconds: string | number | null;
  max_devices: number; max_concurrent_sessions: number; offline_grace_seconds: number;
  allow_self_unbind: boolean; unbind_cooldown_seconds: number; rules: Record<string, unknown>;
  status: LicensePolicy['status']; created_at: Date; updated_at: Date;
}

export class PostgresProductRepository implements ProductRepository {
  public constructor(private readonly database: PostgresDatabase) {}

  public async createProduct(input: CreateProductInput): Promise<ManagedProduct> {
    try {
      const result = await this.database.query<ProductRow>(
        `INSERT INTO products (
           tenant_id, code, name, description, status, minimum_client_version,
           recommended_client_version, force_update_version, settings
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
         RETURNING *`,
        [input.tenantId, input.code, input.name, input.description ?? null, input.status ?? 'ACTIVE',
          input.minimumClientVersion ?? null, input.recommendedClientVersion ?? null,
          input.forceUpdateVersion ?? null, JSON.stringify(input.settings ?? {})],
      );
      return mapProduct(this.first(result.rows));
    } catch (error) { throw mapConflict(error, 'PRODUCT_ALREADY_EXISTS', '产品代码已存在'); }
  }

  public async findProduct(tenantId: string, productId: string): Promise<ManagedProduct | null> {
    const result = await this.database.query<ProductRow>('SELECT * FROM products WHERE tenant_id=$1 AND id=$2', [tenantId, productId]);
    return result.rows[0] === undefined ? null : mapProduct(result.rows[0]);
  }

  public async listProducts(tenantId: string, page: PageInput): Promise<readonly ManagedProduct[]> {
    const result = await this.database.query<ProductRow>(
      'SELECT * FROM products WHERE tenant_id=$1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3',
      [tenantId, page.limit, page.offset],
    );
    return result.rows.map(mapProduct);
  }

  public async updateProduct(tenantId: string, productId: string, input: UpdateProductInput): Promise<ManagedProduct | null> {
    const update = buildUpdate(input, {
      name: 'name', description: 'description', status: 'status', minimumClientVersion: 'minimum_client_version',
      recommendedClientVersion: 'recommended_client_version', forceUpdateVersion: 'force_update_version', settings: 'settings',
    }, new Set(['settings']));
    if (update.assignments.length === 0) return this.findProduct(tenantId, productId);
    const result = await this.database.query<ProductRow>(
      `UPDATE products SET ${update.assignments.join(', ')} WHERE tenant_id=$${update.values.length + 1} AND id=$${update.values.length + 2} RETURNING *`,
      [...update.values, tenantId, productId],
    );
    return result.rows[0] === undefined ? null : mapProduct(result.rows[0]);
  }

  public async createVersion(input: CreateProductVersionInput): Promise<ProductVersion> {
    try {
      const result = await this.database.query<VersionRow>(
        `INSERT INTO product_versions (product_id, version, status, force_update, release_notes, released_at)
         SELECT product.id,$3,$4,$5,$6,$7 FROM products product WHERE product.tenant_id=$1 AND product.id=$2 RETURNING *`,
        [input.tenantId, input.productId, input.version, input.status, input.forceUpdate, input.releaseNotes ?? null, input.releasedAt ?? null],
      );
      if (result.rows[0] === undefined) throw new AppError({ code: 'PRODUCT_NOT_FOUND', message: '产品不存在', statusCode: 404 });
      return mapVersion(result.rows[0]);
    } catch (error) { throw mapConflict(error, 'PRODUCT_VERSION_ALREADY_EXISTS', '产品版本已存在'); }
  }

  public async listVersions(tenantId: string, productId: string): Promise<readonly ProductVersion[]> {
    const result = await this.database.query<VersionRow>(
      `SELECT version.* FROM product_versions version JOIN products product ON product.id=version.product_id
       WHERE product.tenant_id=$1 AND product.id=$2 ORDER BY version.created_at DESC`, [tenantId, productId]);
    return result.rows.map(mapVersion);
  }

  public async updateVersion(tenantId: string, productId: string, versionId: string, input: UpdateProductVersionInput): Promise<ProductVersion | null> {
    const update = buildUpdate(input, { status: 'status', forceUpdate: 'force_update', releaseNotes: 'release_notes', releasedAt: 'released_at' });
    if (update.assignments.length === 0) {
      const rows = await this.listVersions(tenantId, productId); return rows.find((row) => row.id === versionId) ?? null;
    }
    const result = await this.database.query<VersionRow>(
      `UPDATE product_versions version SET ${update.assignments.join(', ')} FROM products product
       WHERE version.product_id=product.id AND product.tenant_id=$${update.values.length + 1}
         AND product.id=$${update.values.length + 2} AND version.id=$${update.values.length + 3}
       RETURNING version.*`, [...update.values, tenantId, productId, versionId]);
    return result.rows[0] === undefined ? null : mapVersion(result.rows[0]);
  }

  public async createFeature(input: CreateFeatureDefinitionInput): Promise<FeatureDefinition> {
    try {
      const result = await this.database.query<FeatureRow>(
        `INSERT INTO feature_definitions (product_id, code, name, description, status)
         SELECT product.id,$3,$4,$5,$6 FROM products product WHERE product.tenant_id=$1 AND product.id=$2 RETURNING *`,
        [input.tenantId, input.productId, input.code, input.name, input.description ?? null, input.status]);
      if (result.rows[0] === undefined) throw new AppError({ code: 'PRODUCT_NOT_FOUND', message: '产品不存在', statusCode: 404 });
      return mapFeature(result.rows[0]);
    } catch (error) { throw mapConflict(error, 'FEATURE_ALREADY_EXISTS', '功能代码已存在'); }
  }

  public async listFeatures(tenantId: string, productId: string): Promise<readonly FeatureDefinition[]> {
    const result = await this.database.query<FeatureRow>(
      `SELECT feature.* FROM feature_definitions feature JOIN products product ON product.id=feature.product_id
       WHERE product.tenant_id=$1 AND product.id=$2 ORDER BY feature.code`, [tenantId, productId]);
    return result.rows.map(mapFeature);
  }

  public async updateFeature(tenantId: string, productId: string, featureId: string, input: UpdateFeatureDefinitionInput): Promise<FeatureDefinition | null> {
    const update = buildUpdate(input, { name: 'name', description: 'description', status: 'status' });
    if (update.assignments.length === 0) {
      const rows = await this.listFeatures(tenantId, productId); return rows.find((row) => row.id === featureId) ?? null;
    }
    const result = await this.database.query<FeatureRow>(
      `UPDATE feature_definitions feature SET ${update.assignments.join(', ')} FROM products product
       WHERE feature.product_id=product.id AND product.tenant_id=$${update.values.length + 1}
         AND product.id=$${update.values.length + 2} AND feature.id=$${update.values.length + 3}
       RETURNING feature.*`, [...update.values, tenantId, productId, featureId]);
    return result.rows[0] === undefined ? null : mapFeature(result.rows[0]);
  }

  public async createPolicy(input: CreateLicensePolicyInput): Promise<LicensePolicy> {
    try {
      const result = await this.database.query<PolicyRow>(
        `INSERT INTO license_policies (
           tenant_id, product_id, code, name, license_type, duration_seconds, max_devices,
           max_concurrent_sessions, offline_grace_seconds, allow_self_unbind,
           unbind_cooldown_seconds, rules, status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13) RETURNING *`,
        [input.tenantId, input.productId ?? null, input.code, input.name, input.licenseType,
          input.durationSeconds ?? null, input.maxDevices, input.maxConcurrentSessions,
          input.offlineGraceSeconds, input.allowSelfUnbind, input.unbindCooldownSeconds,
          JSON.stringify(input.rules), input.status]);
      return mapPolicy(this.first(result.rows));
    } catch (error) { throw mapConflict(error, 'LICENSE_POLICY_ALREADY_EXISTS', '授权策略代码已存在'); }
  }

  public async findPolicy(tenantId: string, policyId: string): Promise<LicensePolicy | null> {
    const result = await this.database.query<PolicyRow>('SELECT * FROM license_policies WHERE tenant_id=$1 AND id=$2', [tenantId, policyId]);
    return result.rows[0] === undefined ? null : mapPolicy(result.rows[0]);
  }

  public async listPolicies(tenantId: string, productId: string | undefined, page: PageInput): Promise<readonly LicensePolicy[]> {
    const result = await this.database.query<PolicyRow>(
      `SELECT * FROM license_policies WHERE tenant_id=$1 AND ($2::uuid IS NULL OR product_id=$2)
       ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`, [tenantId, productId ?? null, page.limit, page.offset]);
    return result.rows.map(mapPolicy);
  }

  public async updatePolicy(tenantId: string, policyId: string, input: UpdateLicensePolicyInput): Promise<LicensePolicy | null> {
    const update = buildUpdate(input, {
      productId: 'product_id', name: 'name', licenseType: 'license_type', durationSeconds: 'duration_seconds',
      maxDevices: 'max_devices', maxConcurrentSessions: 'max_concurrent_sessions', offlineGraceSeconds: 'offline_grace_seconds',
      allowSelfUnbind: 'allow_self_unbind', unbindCooldownSeconds: 'unbind_cooldown_seconds', rules: 'rules', status: 'status',
    }, new Set(['rules']));
    if (update.assignments.length === 0) return this.findPolicy(tenantId, policyId);
    const result = await this.database.query<PolicyRow>(
      `UPDATE license_policies SET ${update.assignments.join(', ')} WHERE tenant_id=$${update.values.length + 1} AND id=$${update.values.length + 2} RETURNING *`,
      [...update.values, tenantId, policyId]);
    return result.rows[0] === undefined ? null : mapPolicy(result.rows[0]);
  }

  private first<Row>(rows: Row[]): Row {
    const first = rows[0]; if (first === undefined) throw new Error('Expected PostgreSQL to return one row'); return first;
  }
}

function buildUpdate<T extends object>(
  input: T,
  columns: Partial<Record<keyof T, string>>,
  jsonFields: ReadonlySet<string> = new Set(),
): { assignments: string[]; values: unknown[] } {
  const assignments: string[] = []; const values: unknown[] = [];
  for (const key of Object.keys(columns) as Array<keyof T>) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    values.push(jsonFields.has(String(key)) ? JSON.stringify(input[key]) : input[key]);
    assignments.push(`${columns[key]}=$${values.length}${jsonFields.has(String(key)) ? '::jsonb' : ''}`);
  }
  return { assignments, values };
}

function mapProduct(row: ProductRow): ManagedProduct { return {
  id: row.id, tenantId: row.tenant_id, code: row.code, name: row.name, description: row.description,
  status: row.status, minimumClientVersion: row.minimum_client_version,
  recommendedClientVersion: row.recommended_client_version, forceUpdateVersion: row.force_update_version,
  settings: row.settings, createdAt: row.created_at, updatedAt: row.updated_at,
}; }
function mapVersion(row: VersionRow): ProductVersion { return {
  id: row.id, productId: row.product_id, version: row.version, status: row.status,
  forceUpdate: row.force_update, releaseNotes: row.release_notes, releasedAt: row.released_at, createdAt: row.created_at,
}; }
function mapFeature(row: FeatureRow): FeatureDefinition { return {
  id: row.id, productId: row.product_id, code: row.code, name: row.name, description: row.description,
  status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
}; }
function mapPolicy(row: PolicyRow): LicensePolicy { return {
  id: row.id, tenantId: row.tenant_id, productId: row.product_id, code: row.code, name: row.name,
  licenseType: row.license_type, durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
  maxDevices: row.max_devices, maxConcurrentSessions: row.max_concurrent_sessions,
  offlineGraceSeconds: row.offline_grace_seconds, allowSelfUnbind: row.allow_self_unbind,
  unbindCooldownSeconds: row.unbind_cooldown_seconds, rules: row.rules, status: row.status,
  createdAt: row.created_at, updatedAt: row.updated_at,
}; }
function mapConflict(error: unknown, code: string, message: string): unknown {
  if (error instanceof AppError) return error;
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
    return new AppError({ code, message, statusCode: 409 });
  }
  return error;
}

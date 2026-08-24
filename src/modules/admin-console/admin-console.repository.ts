import type { QueryResultRow } from 'pg';
import type { PostgresDatabase } from '../../infrastructure/database/postgres-database.js';
import { AppError } from '../../shared/errors/app-error.js';

export type AdminStatus = 'ACTIVE' | 'SUSPENDED' | 'DISABLED';

export interface AdminRoleView {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
  userCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ManagedAdminView {
  id: string;
  email: string;
  displayName: string;
  status: AdminStatus;
  mfaRequired: boolean;
  lastLoginAt: Date | null;
  passwordChangedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  roles: Array<{ id: string; code: string; name: string }>;
}

export interface TenantSettingsView {
  consoleName: string;
  supportEmail: string;
  defaultLicenseDays: number;
  defaultMaxDevices: number;
  expiryWarningDays: number;
  updatedAt: Date | null;
}

interface AdminRow extends QueryResultRow {
  id: string; email: string; display_name: string; status: AdminStatus; mfa_required: boolean;
  last_login_at: Date | null; password_changed_at: Date | null; created_at: Date; updated_at: Date;
  roles: Array<{ id: string; code: string; name: string }>;
}
interface RoleRow extends QueryResultRow {
  id: string; code: string; name: string; description: string | null; is_system: boolean;
  permissions: string[]; user_count: string | number; created_at: Date; updated_at: Date;
}
interface PermissionRow extends QueryResultRow { code: string; name: string; description: string | null }
interface PasswordRow extends QueryResultRow { password_hash: string; session_version: number }
interface CurrentAdminStateRow extends QueryResultRow { status: AdminStatus; is_owner: boolean }
interface CountRow extends QueryResultRow { count: string }
interface SettingsRow extends QueryResultRow { setting_value: Partial<TenantSettingsView>; updated_at: Date }

export class AdminConsoleRepository {
  public constructor(private readonly database: PostgresDatabase) {}

  public async listAdmins(tenantId: string, input: { search?: string; status?: AdminStatus; limit: number; offset: number }): Promise<{ items: ManagedAdminView[]; total: number }> {
    const filters = [tenantId, input.search ?? null, input.status ?? null];
    const [result, count] = await Promise.all([
      this.database.query<AdminRow>(
        `SELECT admin.id, admin.email, admin.display_name, admin.status, admin.mfa_required,
              admin.last_login_at, admin.password_changed_at, admin.created_at, admin.updated_at,
              COALESCE(
                jsonb_agg(DISTINCT jsonb_build_object('id', role.id, 'code', role.code, 'name', role.name))
                  FILTER (WHERE role.id IS NOT NULL), '[]'::jsonb
              ) AS roles
         FROM admin_users admin
         LEFT JOIN admin_user_roles assignment ON assignment.admin_user_id = admin.id
         LEFT JOIN roles role ON role.id = assignment.role_id AND role.tenant_id = admin.tenant_id
        WHERE admin.tenant_id = $1
          AND ($2::text IS NULL OR admin.email ILIKE '%' || $2 || '%' OR admin.display_name ILIKE '%' || $2 || '%')
          AND ($3::text IS NULL OR admin.status = $3)
        GROUP BY admin.id
        ORDER BY admin.created_at DESC, admin.id DESC
        LIMIT $4 OFFSET $5`,
        [...filters, input.limit, input.offset],
      ),
      this.database.query<CountRow>(
        `SELECT COUNT(*)::text AS count
           FROM admin_users admin
          WHERE admin.tenant_id = $1
            AND ($2::text IS NULL OR admin.email ILIKE '%' || $2 || '%' OR admin.display_name ILIKE '%' || $2 || '%')
            AND ($3::text IS NULL OR admin.status = $3)`,
        filters,
      ),
    ]);
    return { items: result.rows.map(mapAdmin), total: Number(count.rows[0]?.count ?? 0) };
  }

  public async findAdmin(tenantId: string, adminId: string): Promise<ManagedAdminView | null> {
    const result = await this.database.query<AdminRow>(
      `SELECT admin.id, admin.email, admin.display_name, admin.status, admin.mfa_required,
              admin.last_login_at, admin.password_changed_at, admin.created_at, admin.updated_at,
              COALESCE(
                jsonb_agg(DISTINCT jsonb_build_object('id', role.id, 'code', role.code, 'name', role.name))
                  FILTER (WHERE role.id IS NOT NULL), '[]'::jsonb
              ) AS roles
         FROM admin_users admin
         LEFT JOIN admin_user_roles assignment ON assignment.admin_user_id = admin.id
         LEFT JOIN roles role ON role.id = assignment.role_id AND role.tenant_id = admin.tenant_id
        WHERE admin.tenant_id = $1 AND admin.id = $2
        GROUP BY admin.id`,
      [tenantId, adminId],
    );
    return result.rows[0] === undefined ? null : mapAdmin(result.rows[0]);
  }

  public async findAdminById(adminId: string): Promise<ManagedAdminView | null> {
    const result = await this.database.query<AdminRow>(
      `SELECT admin.id, admin.email, admin.display_name, admin.status, admin.mfa_required,
              admin.last_login_at, admin.password_changed_at, admin.created_at, admin.updated_at,
              COALESCE(
                jsonb_agg(DISTINCT jsonb_build_object('id', role.id, 'code', role.code, 'name', role.name))
                  FILTER (WHERE role.id IS NOT NULL), '[]'::jsonb
              ) AS roles
         FROM admin_users admin
         LEFT JOIN admin_user_roles assignment ON assignment.admin_user_id = admin.id
         LEFT JOIN roles role ON role.id = assignment.role_id
           AND ((admin.tenant_id IS NULL AND role.scope = 'PLATFORM' AND role.tenant_id IS NULL)
             OR (admin.tenant_id IS NOT NULL AND role.scope = 'TENANT' AND role.tenant_id = admin.tenant_id))
        WHERE admin.id = $1
        GROUP BY admin.id`,
      [adminId],
    );
    return result.rows[0] === undefined ? null : mapAdmin(result.rows[0]);
  }

  public async createAdmin(input: { tenantId: string; email: string; displayName: string; passwordHash: string; roleIds: string[]; actorId: string }): Promise<ManagedAdminView> {
    const id = await this.database.transaction(async (client) => {
      await assertRolesBelongToTenant(client, input.tenantId, input.roleIds);
      try {
        const inserted = await client.query<{ id: string } & QueryResultRow>(
          `INSERT INTO admin_users (tenant_id, email, display_name, password_hash, status, created_by, password_changed_at)
           VALUES ($1, $2, $3, $4, 'ACTIVE', $5, NOW()) RETURNING id`,
          [input.tenantId, input.email, input.displayName, input.passwordHash, input.actorId],
        );
        const adminId = inserted.rows[0]!.id;
        for (const roleId of uniqueValues(input.roleIds)) {
          await client.query(
            `INSERT INTO admin_user_roles (admin_user_id, role_id, assigned_by) VALUES ($1, $2, $3)`,
            [adminId, roleId, input.actorId],
          );
        }
        return adminId;
      } catch (error) {
        if (isUniqueViolation(error)) throw new AppError({ code: 'ADMIN_EMAIL_EXISTS', message: '该工作区已经存在相同邮箱的管理员', statusCode: 409 });
        throw error;
      }
    });
    return (await this.findAdmin(input.tenantId, id))!;
  }

  public async updateAdmin(input: { tenantId: string; adminId: string; email?: string; displayName?: string; status?: AdminStatus; roleIds?: string[]; actorId: string }): Promise<{ before: ManagedAdminView; after: ManagedAdminView }> {
    const before = await this.findAdmin(input.tenantId, input.adminId);
    if (before === null) throw notFound('管理员不存在');
    await this.database.transaction(async (client) => {
      if (input.roleIds !== undefined) await assertRolesBelongToTenant(client, input.tenantId, input.roleIds);
      // 串行化同一工作区的 owner 变更，并在锁内重新读取目标状态，避免使用事务外的陈旧数据。
      await client.query("SELECT pg_advisory_xact_lock(hashtext('tenant-owner:' || $1::text))", [input.tenantId]);
      const currentResult = await client.query<CurrentAdminStateRow>(
        `SELECT admin.status,
                EXISTS (
                  SELECT 1
                    FROM admin_user_roles assignment
                    JOIN roles role ON role.id = assignment.role_id
                   WHERE assignment.admin_user_id = admin.id
                     AND role.scope = 'TENANT'
                     AND role.tenant_id = admin.tenant_id
                     AND role.code = 'owner'
                ) AS is_owner
           FROM admin_users admin
          WHERE admin.tenant_id = $1 AND admin.id = $2
          FOR UPDATE`,
        [input.tenantId, input.adminId],
      );
      const current = currentResult.rows[0];
      if (current === undefined) throw notFound('管理员不存在');
      const remainsActive = (input.status ?? current.status) === 'ACTIVE';
      const remainsOwner = input.roleIds === undefined
        ? current.is_owner
        : await roleIdsContainOwner(client, input.tenantId, input.roleIds);
      if (current.status === 'ACTIVE' && current.is_owner && (!remainsActive || !remainsOwner)) {
        const activeOwners = await client.query<CountRow>(
          `SELECT COUNT(DISTINCT admin.id)::text AS count
             FROM admin_users admin
             JOIN admin_user_roles assignment ON assignment.admin_user_id = admin.id
             JOIN roles role ON role.id = assignment.role_id
              AND role.scope = 'TENANT'
              AND role.tenant_id = admin.tenant_id
            WHERE admin.tenant_id = $1 AND admin.status = 'ACTIVE' AND role.code = 'owner'`,
          [input.tenantId],
        );
        if (Number(activeOwners.rows[0]!.count) <= 1) throw new AppError({ code: 'LAST_OWNER_REQUIRED', message: '工作区必须保留至少一名启用状态的所有者', statusCode: 409 });
      }
      const assignments: string[] = [];
      const values: unknown[] = [];
      const add = (column: string, value: unknown) => { values.push(value); assignments.push(`${column} = $${values.length}`); };
      if (input.email !== undefined) add('email', input.email);
      if (input.displayName !== undefined) add('display_name', input.displayName);
      if (input.status !== undefined) {
        add('status', input.status);
        if (input.status !== 'ACTIVE') assignments.push('session_version = session_version + 1');
      }
      if (assignments.length > 0) {
        values.push(input.tenantId, input.adminId);
        try { await client.query(`UPDATE admin_users SET ${assignments.join(', ')} WHERE tenant_id = $${values.length - 1} AND id = $${values.length}`, values); }
        catch (error) { if (isUniqueViolation(error)) throw new AppError({ code: 'ADMIN_EMAIL_EXISTS', message: '该工作区已经存在相同邮箱的管理员', statusCode: 409 }); throw error; }
      }
      if (input.roleIds !== undefined) {
        await client.query('DELETE FROM admin_user_roles WHERE admin_user_id = $1', [input.adminId]);
        for (const roleId of uniqueValues(input.roleIds)) await client.query(
          'INSERT INTO admin_user_roles (admin_user_id, role_id, assigned_by) VALUES ($1, $2, $3)',
          [input.adminId, roleId, input.actorId],
        );
      }
    });
    return { before, after: (await this.findAdmin(input.tenantId, input.adminId))! };
  }

  public async passwordRecord(userId: string): Promise<PasswordRow | null> {
    const result = await this.database.query<PasswordRow>('SELECT password_hash, session_version FROM admin_users WHERE id = $1 AND status = \'ACTIVE\'', [userId]);
    return result.rows[0] ?? null;
  }

  public async replacePassword(userId: string, passwordHash: string): Promise<number> {
    const result = await this.database.query<PasswordRow>(
      `UPDATE admin_users SET password_hash = $2, password_changed_at = NOW(), session_version = session_version + 1
        WHERE id = $1 RETURNING password_hash, session_version`,
      [userId, passwordHash],
    );
    if (result.rows[0] === undefined) throw notFound('管理员不存在');
    return result.rows[0].session_version;
  }

  public async updateOwnProfile(userId: string, displayName: string): Promise<ManagedAdminView> {
    const result = await this.database.query<{ id: string } & QueryResultRow>(
      `UPDATE admin_users SET display_name = $2 WHERE id = $1 AND status = 'ACTIVE' RETURNING id`,
      [userId, displayName],
    );
    if (result.rows[0] === undefined) throw notFound('管理员不存在');
    const admin = await this.findAdminById(userId);
    if (admin === null) throw notFound('管理员不存在');
    return admin;
  }

  public async listRoles(tenantId: string): Promise<AdminRoleView[]> {
    const result = await this.database.query<RoleRow>(
      `SELECT role.id, role.code, role.name, role.description, role.is_system, role.created_at, role.updated_at,
              COALESCE(array_agg(DISTINCT permission.code) FILTER (WHERE permission.code IS NOT NULL), '{}') AS permissions,
              COUNT(DISTINCT assignment.admin_user_id)::text AS user_count
         FROM roles role
         LEFT JOIN role_permissions grant_row ON grant_row.role_id = role.id
         LEFT JOIN permissions permission ON permission.code = grant_row.permission_code
         LEFT JOIN admin_user_roles assignment ON assignment.role_id = role.id
        WHERE role.scope = 'TENANT' AND role.tenant_id = $1
        GROUP BY role.id ORDER BY role.is_system DESC, role.created_at ASC`, [tenantId],
    );
    return result.rows.map(mapRole);
  }

  public async listPermissions(): Promise<Array<{ code: string; name: string; description: string | null }>> {
    const result = await this.database.query<PermissionRow>(
      `SELECT code, name, description FROM permissions
        WHERE code NOT IN ('platform.tenants.manage', 'settings.manage', 'signing-keys.manage') ORDER BY code`,
    );
    return result.rows;
  }

  public async createRole(input: { tenantId: string; code: string; name: string; description?: string; permissions: string[] }): Promise<AdminRoleView> {
    const id = await this.database.transaction(async (client) => {
      await assertPermissionsAllowed(client, input.permissions);
      try {
        const created = await client.query<{ id: string } & QueryResultRow>(
          `INSERT INTO roles (tenant_id, scope, code, name, description, is_system)
           VALUES ($1, 'TENANT', $2, $3, $4, FALSE) RETURNING id`,
          [input.tenantId, input.code, input.name, input.description ?? null],
        );
        const roleId = created.rows[0]!.id;
        for (const code of uniqueValues(input.permissions)) await client.query(
          'INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2)', [roleId, code],
        );
        return roleId;
      } catch (error) { if (isUniqueViolation(error)) throw new AppError({ code: 'ROLE_CODE_EXISTS', message: '角色代码已经存在', statusCode: 409 }); throw error; }
    });
    return (await this.listRoles(input.tenantId)).find((role) => role.id === id)!;
  }

  public async updateRole(input: { tenantId: string; roleId: string; name?: string; description?: string | null; permissions?: string[] }): Promise<AdminRoleView> {
    await this.database.transaction(async (client) => {
      const current = await client.query<{ is_system: boolean; code: string } & QueryResultRow>(
        'SELECT is_system, code FROM roles WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [input.tenantId, input.roleId],
      );
      if (current.rows[0] === undefined) throw notFound('角色不存在');
      if (current.rows[0].is_system || current.rows[0].code === 'owner') throw new AppError({ code: 'SYSTEM_ROLE_IMMUTABLE', message: '系统所有者角色不允许修改', statusCode: 409 });
      if (input.permissions !== undefined) await assertPermissionsAllowed(client, input.permissions);
      const sets: string[] = []; const values: unknown[] = [];
      if (input.name !== undefined) { values.push(input.name); sets.push(`name = $${values.length}`); }
      if (input.description !== undefined) { values.push(input.description); sets.push(`description = $${values.length}`); }
      if (sets.length > 0) { values.push(input.roleId); await client.query(`UPDATE roles SET ${sets.join(', ')} WHERE id = $${values.length}`, values); }
      if (input.permissions !== undefined) {
        await client.query('DELETE FROM role_permissions WHERE role_id = $1', [input.roleId]);
        for (const code of uniqueValues(input.permissions)) await client.query('INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2)', [input.roleId, code]);
      }
    });
    return (await this.listRoles(input.tenantId)).find((role) => role.id === input.roleId)!;
  }

  public async getTenantSettings(tenantId: string): Promise<TenantSettingsView> {
    const result = await this.database.query<SettingsRow>(
      `SELECT setting_value, updated_at FROM system_settings
        WHERE scope = 'TENANT' AND scope_id = $1 AND setting_key = 'console.general'`, [tenantId],
    );
    return normalizeSettings(result.rows[0]?.setting_value, result.rows[0]?.updated_at ?? null);
  }

  public async updateTenantSettings(tenantId: string, actorId: string, settings: Omit<TenantSettingsView, 'updatedAt'>): Promise<TenantSettingsView> {
    const result = await this.database.query<SettingsRow>(
      `INSERT INTO system_settings (scope, scope_id, setting_key, setting_value, is_sensitive, updated_by)
       VALUES ('TENANT', $1, 'console.general', $2::jsonb, FALSE, $3)
       ON CONFLICT (scope, (COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)), setting_key)
       DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_by = EXCLUDED.updated_by
       RETURNING setting_value, updated_at`, [tenantId, JSON.stringify(settings), actorId],
    );
    return normalizeSettings(result.rows[0]!.setting_value, result.rows[0]!.updated_at);
  }
}

function mapAdmin(row: AdminRow): ManagedAdminView { return { id: row.id, email: row.email, displayName: row.display_name, status: row.status, mfaRequired: row.mfa_required, lastLoginAt: row.last_login_at, passwordChangedAt: row.password_changed_at, createdAt: row.created_at, updatedAt: row.updated_at, roles: row.roles ?? [] }; }
function mapRole(row: RoleRow): AdminRoleView { return { id: row.id, code: row.code, name: row.name, description: row.description, isSystem: row.is_system, permissions: row.permissions ?? [], userCount: Number(row.user_count), createdAt: row.created_at, updatedAt: row.updated_at }; }
function normalizeSettings(value: Partial<TenantSettingsView> | undefined, updatedAt: Date | null): TenantSettingsView { return { consoleName: typeof value?.consoleName === 'string' ? value.consoleName : 'Universal Authorization', supportEmail: typeof value?.supportEmail === 'string' ? value.supportEmail : '', defaultLicenseDays: typeof value?.defaultLicenseDays === 'number' && Number.isInteger(value.defaultLicenseDays) ? value.defaultLicenseDays : 30, defaultMaxDevices: typeof value?.defaultMaxDevices === 'number' && Number.isInteger(value.defaultMaxDevices) ? value.defaultMaxDevices : 1, expiryWarningDays: typeof value?.expiryWarningDays === 'number' && Number.isInteger(value.expiryWarningDays) ? value.expiryWarningDays : 7, updatedAt }; }
function notFound(message: string): AppError { return new AppError({ code: 'RESOURCE_NOT_FOUND', message, statusCode: 404 }); }
function isUniqueViolation(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === '23505'; }
async function assertRolesBelongToTenant(client: { query: Function }, tenantId: string, roleIds: string[]): Promise<void> { const result = await client.query('SELECT id FROM roles WHERE tenant_id = $1 AND scope = \'TENANT\' AND id = ANY($2::uuid[])', [tenantId, roleIds]); if (result.rows.length !== new Set(roleIds).size) throw new AppError({ code: 'INVALID_ADMIN_ROLES', message: '包含不存在或不属于当前工作区的角色', statusCode: 400 }); }
async function roleIdsContainOwner(client: { query: Function }, tenantId: string, roleIds: string[]): Promise<boolean> { const result = await client.query("SELECT 1 FROM roles WHERE tenant_id = $1 AND code = 'owner' AND id = ANY($2::uuid[]) LIMIT 1", [tenantId, roleIds]); return result.rows.length > 0; }
async function assertPermissionsAllowed(client: { query: Function }, codes: string[]): Promise<void> { const unique = [...new Set(codes)]; const result = await client.query("SELECT code FROM permissions WHERE code = ANY($1::text[]) AND code NOT IN ('platform.tenants.manage','settings.manage','signing-keys.manage')", [unique]); if (result.rows.length !== unique.length) throw new AppError({ code: 'INVALID_ROLE_PERMISSIONS', message: '包含不存在或平台专属的权限', statusCode: 400 }); }

function uniqueValues<T>(values: readonly T[]): T[] { return [...new Set(values)]; }

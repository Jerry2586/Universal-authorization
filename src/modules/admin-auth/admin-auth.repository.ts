import type { QueryResultRow } from 'pg';
import type { PostgresDatabase } from '../../infrastructure/database/postgres-database.js';

export interface AdminLoginRecord {
  id: string;
  tenantId: string | null;
  tenantCode: string | null;
  tenantName: string | null;
  tenantStatus: string | null;
  email: string;
  displayName: string;
  passwordHash: string;
  status: string;
  mfaRequired: boolean;
  sessionVersion: number;
}

export interface AdminView {
  id: string;
  tenantId: string | null;
  tenantCode: string | null;
  tenantName: string | null;
  email: string;
  displayName: string;
  permissions: string[];
  sessionVersion: number;
  status: string;
  lastLoginAt: Date | null;
  createdAt: Date;
  roles: Array<{ id: string; code: string; name: string }>;
}

interface LoginRow extends QueryResultRow {
  id: string;
  tenant_id: string | null;
  tenant_code: string | null;
  tenant_name: string | null;
  tenant_status: string | null;
  email: string;
  display_name: string;
  password_hash: string;
  status: string;
  mfa_required: boolean;
  session_version: number;
}

interface ViewRow extends QueryResultRow {
  id: string;
  tenant_id: string | null;
  tenant_code: string | null;
  tenant_name: string | null;
  email: string;
  display_name: string;
  permission_code: string | null;
  status: string;
  session_version: number;
  last_login_at: Date | null;
  created_at: Date;
  role_id: string | null;
  role_code: string | null;
  role_name: string | null;
}

export class AdminAuthRepository {
  public constructor(private readonly database: PostgresDatabase) {}

  public async findForLogin(email: string, tenantCode?: string): Promise<AdminLoginRecord | null> {
    const result = await this.database.query<LoginRow>(
      `SELECT admin.id, admin.tenant_id, tenant.code AS tenant_code, tenant.name AS tenant_name,
              tenant.status AS tenant_status, admin.email, admin.display_name, admin.password_hash,
              admin.status, admin.mfa_required, admin.session_version
         FROM admin_users admin
         LEFT JOIN tenants tenant ON tenant.id = admin.tenant_id
        WHERE LOWER(admin.email) = LOWER($1)
          AND ($2::text IS NULL OR LOWER(tenant.code) = LOWER($2))
        ORDER BY admin.created_at ASC
        LIMIT 2`,
      [email, tenantCode ?? null],
    );
    if (result.rows.length !== 1) return null;
    const row = result.rows[0]!;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      tenantCode: row.tenant_code,
      tenantName: row.tenant_name,
      tenantStatus: row.tenant_status,
      email: row.email,
      displayName: row.display_name,
      passwordHash: row.password_hash,
      status: row.status,
      mfaRequired: row.mfa_required,
      sessionVersion: row.session_version,
    };
  }

  public async getAdminView(userId: string): Promise<AdminView | null> {
    const result = await this.database.query<ViewRow>(
      `SELECT admin.id, admin.tenant_id, tenant.code AS tenant_code, tenant.name AS tenant_name,
              admin.email, admin.display_name, admin.status, admin.session_version, admin.last_login_at, admin.created_at,
              role.id AS role_id, role.code AS role_code, role.name AS role_name, permission.code AS permission_code
         FROM admin_users admin
         LEFT JOIN tenants tenant ON tenant.id = admin.tenant_id
         LEFT JOIN admin_user_roles assignment ON assignment.admin_user_id = admin.id
         LEFT JOIN roles role ON role.id = assignment.role_id
           AND ((admin.tenant_id IS NULL AND role.scope = 'PLATFORM' AND role.tenant_id IS NULL)
             OR (admin.tenant_id IS NOT NULL AND role.scope = 'TENANT' AND role.tenant_id = admin.tenant_id))
         LEFT JOIN role_permissions role_permission ON role_permission.role_id = role.id
         LEFT JOIN permissions permission ON permission.code = role_permission.permission_code
        WHERE admin.id = $1 AND admin.status = 'ACTIVE'
          AND (admin.tenant_id IS NULL OR tenant.status = 'ACTIVE')`,
      [userId],
    );
    const first = result.rows[0];
    if (first === undefined) return null;
    return {
      id: first.id,
      tenantId: first.tenant_id,
      tenantCode: first.tenant_code,
      tenantName: first.tenant_name,
      email: first.email,
      displayName: first.display_name,
      permissions: [...new Set(result.rows.flatMap((row) => row.permission_code === null ? [] : [row.permission_code]))],
      sessionVersion: first.session_version,
      status: first.status,
      lastLoginAt: first.last_login_at,
      createdAt: first.created_at,
      roles: [...new Map(result.rows.flatMap((row) => row.role_id === null || row.role_code === null || row.role_name === null ? [] : [[row.role_id, { id: row.role_id, code: row.role_code, name: row.role_name }] as const])).values()],
    };
  }

  public async updateLastLogin(userId: string): Promise<void> {
    await this.database.query('UPDATE admin_users SET last_login_at = NOW() WHERE id = $1', [userId]);
  }
}

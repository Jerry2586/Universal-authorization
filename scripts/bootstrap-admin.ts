import type { QueryResultRow } from 'pg';
import { loadConfig, loadLocalEnvFile } from '../src/config/env.js';
import { PostgresDatabase } from '../src/infrastructure/database/postgres-database.js';
import { hashAdminPassword } from '../src/modules/admin-auth/admin-password.js';

interface IdRow extends QueryResultRow { id: string }

loadLocalEnvFile();
const email = required('ADMIN_BOOTSTRAP_EMAIL').toLowerCase();
const password = required('ADMIN_BOOTSTRAP_PASSWORD');
const tenantCode = process.env.ADMIN_BOOTSTRAP_TENANT_CODE?.trim() || 'default';
const tenantName = process.env.ADMIN_BOOTSTRAP_TENANT_NAME?.trim() || '默认工作区';
const displayName = process.env.ADMIN_BOOTSTRAP_DISPLAY_NAME?.trim() || '系统管理员';
const resetPassword = process.env.ADMIN_BOOTSTRAP_RESET_PASSWORD === 'true';

if (password.length < 12) throw new Error('ADMIN_BOOTSTRAP_PASSWORD 至少需要 12 个字符');
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tenantCode)) throw new Error('ADMIN_BOOTSTRAP_TENANT_CODE 格式不正确');

const config = loadConfig();
const database = new PostgresDatabase({
  connectionString: config.databaseUrl,
  maxConnections: 1,
  idleTimeoutMs: config.databaseIdleTimeoutMs,
  connectionTimeoutMs: config.infrastructureConnectTimeoutMs,
  applicationName: 'universal-license-admin-bootstrap',
});

try {
  await database.connect();
  const result = await database.transaction(async (client) => {
    const tenant = await client.query<IdRow>(
      `INSERT INTO tenants (code, name, status) VALUES ($1, $2, 'ACTIVE')
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [tenantCode, tenantName],
    );
    const tenantId = tenant.rows[0]!.id;
    const existing = await client.query<IdRow>(
      'SELECT id FROM admin_users WHERE tenant_id = $1 AND LOWER(email) = LOWER($2)',
      [tenantId, email],
    );

    let adminId: string;
    let created = false;
    if (existing.rows[0] === undefined) {
      const passwordHash = await hashAdminPassword(password);
      const inserted = await client.query<IdRow>(
        `INSERT INTO admin_users (tenant_id, email, display_name, password_hash, status)
         VALUES ($1, $2, $3, $4, 'ACTIVE') RETURNING id`,
        [tenantId, email, displayName, passwordHash],
      );
      adminId = inserted.rows[0]!.id;
      created = true;
    } else {
      adminId = existing.rows[0].id;
      if (resetPassword) {
        const passwordHash = await hashAdminPassword(password);
        await client.query(
          `UPDATE admin_users
              SET display_name = $2, password_hash = $3, status = 'ACTIVE',
                  password_changed_at = NOW(), session_version = session_version + 1
            WHERE id = $1`,
          [adminId, displayName, passwordHash],
        );
      }
    }

    const existingRole = await client.query<IdRow>(
      `SELECT id FROM roles WHERE tenant_id = $1 AND scope = 'TENANT' AND code = 'owner'`,
      [tenantId],
    );
    let roleId = existingRole.rows[0]?.id;
    if (roleId === undefined) {
      const role = await client.query<IdRow>(
        `INSERT INTO roles (tenant_id, scope, code, name, description, is_system)
         VALUES ($1, 'TENANT', 'owner', '工作区所有者', '拥有当前工作区全部管理权限', TRUE)
         RETURNING id`,
        [tenantId],
      );
      roleId = role.rows[0]!.id;
    }
    await client.query(
      `INSERT INTO role_permissions (role_id, permission_code)
       SELECT $1, code
         FROM permissions
        WHERE code NOT IN ('platform.tenants.manage', 'settings.manage', 'signing-keys.manage')
       ON CONFLICT DO NOTHING`,
      [roleId],
    );
    await client.query(
      `INSERT INTO admin_user_roles (admin_user_id, role_id, assigned_by)
       VALUES ($1, $2, $1) ON CONFLICT DO NOTHING`,
      [adminId, roleId],
    );
    return { created, reset: !created && resetPassword };
  });

  if (result.created) console.log(`[管理后台] 已创建首个管理员：${email}（工作区：${tenantCode}）`);
  else if (result.reset) console.log(`[管理后台] 已重置管理员密码：${email}（工作区：${tenantCode}）`);
  else console.log(`[管理后台] 管理员已存在，保留原密码：${email}（工作区：${tenantCode}）`);
} finally {
  await database.close();
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === '') throw new Error(`缺少环境变量 ${name}`);
  return value;
}

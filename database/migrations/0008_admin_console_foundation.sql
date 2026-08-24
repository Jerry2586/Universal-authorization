-- 管理后台成熟化第一阶段：管理员账号、会话版本、角色与租户设置。

ALTER TABLE admin_users
  ADD COLUMN session_version INTEGER NOT NULL DEFAULT 1 CHECK (session_version > 0),
  ADD COLUMN password_changed_at TIMESTAMPTZ,
  ADD COLUMN created_by UUID REFERENCES admin_users(id) ON DELETE SET NULL;

CREATE INDEX admin_users_tenant_status_created_idx
  ON admin_users (tenant_id, status, created_at DESC, id DESC);

CREATE INDEX admin_user_roles_role_user_idx
  ON admin_user_roles (role_id, admin_user_id);

INSERT INTO permissions (code, name, description) VALUES
  ('tenant.settings.manage', '管理工作区设置', '修改当前工作区的品牌、授权默认值和安全设置')
ON CONFLICT (code) DO NOTHING;

-- 清理历史引导脚本可能授予租户角色的平台专属权限，数据库层与运行时权限边界保持一致。
DELETE FROM role_permissions grant_row
USING roles role
WHERE grant_row.role_id = role.id
  AND role.scope = 'TENANT'
  AND grant_row.permission_code IN ('platform.tenants.manage', 'settings.manage', 'signing-keys.manage');

-- 已部署环境中的 owner 角色自动获得新增权限，不要求重新执行管理员引导脚本。
INSERT INTO role_permissions (role_id, permission_code)
SELECT id, 'tenant.settings.manage'
  FROM roles
 WHERE scope = 'TENANT' AND code = 'owner'
ON CONFLICT DO NOTHING;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) NOT NULL,
  code VARCHAR(64) NOT NULL UNIQUE,
  status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DISABLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE admin_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT,
  email VARCHAR(320) NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  password_hash TEXT NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DISABLED')),
  mfa_required BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX admin_users_tenant_email_uidx
  ON admin_users (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::UUID), LOWER(email));

CREATE TABLE roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  scope VARCHAR(16) NOT NULL CHECK (scope IN ('PLATFORM', 'TENANT')),
  code VARCHAR(64) NOT NULL,
  name VARCHAR(120) NOT NULL,
  description TEXT,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (scope = 'PLATFORM' AND tenant_id IS NULL)
    OR (scope = 'TENANT' AND tenant_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX roles_scope_code_uidx
  ON roles (scope, COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::UUID), code);

CREATE TABLE permissions (
  code VARCHAR(96) PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE admin_user_roles (
  admin_user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  assigned_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (admin_user_id, role_id)
);

CREATE TABLE role_permissions (
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code VARCHAR(96) NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  code VARCHAR(64) NOT NULL,
  name VARCHAR(120) NOT NULL,
  description TEXT,
  status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'DISABLED')),
  minimum_client_version VARCHAR(64),
  recommended_client_version VARCHAR(64),
  force_update_version VARCHAR(64),
  settings JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE product_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  version VARCHAR(64) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'BLOCKED', 'DEPRECATED')),
  force_update BOOLEAN NOT NULL DEFAULT FALSE,
  release_notes TEXT,
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, version)
);

CREATE TABLE api_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id) ON DELETE CASCADE,
  client_id VARCHAR(96) NOT NULL,
  name VARCHAR(120) NOT NULL,
  client_type VARCHAR(24) NOT NULL
    CHECK (client_type IN ('ADMIN', 'PRODUCT', 'SERVICE')),
  public_key TEXT,
  status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'DISABLED', 'REVOKED')),
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, client_id),
  CHECK (client_type <> 'PRODUCT' OR product_id IS NOT NULL)
);

CREATE TABLE license_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  product_id UUID REFERENCES products(id) ON DELETE CASCADE,
  code VARCHAR(64) NOT NULL,
  name VARCHAR(120) NOT NULL,
  license_type VARCHAR(24) NOT NULL
    CHECK (license_type IN ('TRIAL', 'DURATION', 'FIXED_EXPIRY', 'PERPETUAL')),
  duration_seconds BIGINT CHECK (duration_seconds IS NULL OR duration_seconds > 0),
  max_devices INTEGER NOT NULL DEFAULT 1 CHECK (max_devices > 0),
  max_concurrent_sessions INTEGER NOT NULL DEFAULT 1 CHECK (max_concurrent_sessions > 0),
  offline_grace_seconds INTEGER NOT NULL DEFAULT 86400 CHECK (offline_grace_seconds >= 0),
  allow_self_unbind BOOLEAN NOT NULL DEFAULT FALSE,
  unbind_cooldown_seconds INTEGER NOT NULL DEFAULT 604800 CHECK (unbind_cooldown_seconds >= 0),
  rules JSONB NOT NULL DEFAULT '{}'::JSONB,
  status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE license_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  policy_id UUID REFERENCES license_policies(id) ON DELETE SET NULL,
  key_hash VARCHAR(128) NOT NULL,
  key_prefix VARCHAR(16) NOT NULL,
  key_suffix VARCHAR(16) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'CREATED'
    CHECK (status IN ('CREATED', 'ACTIVE', 'SUSPENDED', 'EXPIRED', 'REVOKED', 'DISABLED')),
  license_type VARCHAR(24) NOT NULL
    CHECK (license_type IN ('TRIAL', 'DURATION', 'FIXED_EXPIRY', 'PERPETUAL')),
  starts_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  max_devices INTEGER NOT NULL DEFAULT 1 CHECK (max_devices > 0),
  max_concurrent_sessions INTEGER NOT NULL DEFAULT 1 CHECK (max_concurrent_sessions > 0),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, key_hash),
  CHECK (expires_at IS NULL OR starts_at IS NULL OR expires_at > starts_at),
  CHECK (status <> 'REVOKED' OR revoked_at IS NOT NULL)
);

CREATE INDEX license_keys_tenant_status_idx ON license_keys (tenant_id, status);
CREATE INDEX license_keys_product_status_idx ON license_keys (product_id, status);
CREATE INDEX license_keys_expires_at_idx ON license_keys (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX license_keys_display_idx ON license_keys (key_prefix, key_suffix);

CREATE TABLE devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  device_public_key TEXT NOT NULL,
  device_public_key_fingerprint VARCHAR(128) NOT NULL,
  fingerprint_hash VARCHAR(128) NOT NULL,
  platform VARCHAR(32) NOT NULL,
  os_version VARCHAR(128),
  display_name VARCHAR(120),
  status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'BLOCKED', 'DISABLED')),
  risk_score INTEGER NOT NULL DEFAULT 0 CHECK (risk_score BETWEEN 0 AND 100),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, device_public_key_fingerprint)
);

CREATE INDEX devices_tenant_fingerprint_idx ON devices (tenant_id, fingerprint_hash);
CREATE INDEX devices_tenant_status_idx ON devices (tenant_id, status);

CREATE TABLE activations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  license_key_id UUID NOT NULL REFERENCES license_keys(id) ON DELETE RESTRICT,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'UNBOUND', 'BLOCKED', 'REPLACED')),
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_verified_at TIMESTAMPTZ,
  unbound_at TIMESTAMPTZ,
  unbound_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (license_key_id, device_id)
);

CREATE INDEX activations_license_status_idx ON activations (license_key_id, status);
CREATE INDEX activations_device_status_idx ON activations (device_id, status);

CREATE TABLE feature_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  code VARCHAR(96) NOT NULL,
  name VARCHAR(120) NOT NULL,
  description TEXT,
  status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, code)
);

CREATE TABLE feature_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_key_id UUID NOT NULL REFERENCES license_keys(id) ON DELETE CASCADE,
  feature_id UUID NOT NULL REFERENCES feature_definitions(id) ON DELETE CASCADE,
  allowed BOOLEAN NOT NULL DEFAULT TRUE,
  limits JSONB NOT NULL DEFAULT '{}'::JSONB,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (license_key_id, feature_id)
);

CREATE TABLE license_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  license_key_id UUID NOT NULL REFERENCES license_keys(id) ON DELETE RESTRICT,
  activation_id UUID NOT NULL REFERENCES activations(id) ON DELETE RESTRICT,
  token_jti UUID NOT NULL UNIQUE,
  status VARCHAR(24) NOT NULL DEFAULT 'VALID'
    CHECK (status IN ('VALID', 'GRACE', 'EXPIRED', 'REVOKED')),
  client_version VARCHAR(64) NOT NULL,
  ip_address INET,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  offline_until TIMESTAMPTZ,
  last_heartbeat_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at > issued_at),
  CHECK (offline_until IS NULL OR offline_until >= expires_at)
);

CREATE INDEX license_sessions_license_status_idx ON license_sessions (license_key_id, status);
CREATE INDEX license_sessions_activation_status_idx ON license_sessions (activation_id, status);
CREATE INDEX license_sessions_expiry_idx ON license_sessions (expires_at);

CREATE TABLE session_heartbeats (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  session_id UUID NOT NULL REFERENCES license_sessions(id) ON DELETE CASCADE,
  request_id VARCHAR(128),
  ip_address INET,
  client_version VARCHAR(64),
  result VARCHAR(24) NOT NULL CHECK (result IN ('ACCEPTED', 'REJECTED')),
  rejection_code VARCHAR(96),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX session_heartbeats_session_time_idx
  ON session_heartbeats (session_id, received_at DESC);
CREATE INDEX session_heartbeats_tenant_time_idx
  ON session_heartbeats (tenant_id, received_at DESC);

CREATE TABLE device_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
  fingerprint_hash VARCHAR(128),
  reason VARCHAR(255) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'RELEASED')),
  blocked_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  blocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  released_at TIMESTAMPTZ,
  CHECK (device_id IS NOT NULL OR fingerprint_hash IS NOT NULL),
  CHECK (status <> 'RELEASED' OR released_at IS NOT NULL)
);

CREATE INDEX device_blocks_device_active_idx
  ON device_blocks (device_id, status) WHERE device_id IS NOT NULL;
CREATE INDEX device_blocks_fingerprint_active_idx
  ON device_blocks (tenant_id, fingerprint_hash, status) WHERE fingerprint_hash IS NOT NULL;

CREATE TABLE license_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  license_key_id UUID REFERENCES license_keys(id) ON DELETE SET NULL,
  device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  activation_id UUID REFERENCES activations(id) ON DELETE SET NULL,
  session_id UUID REFERENCES license_sessions(id) ON DELETE SET NULL,
  event_type VARCHAR(96) NOT NULL,
  result VARCHAR(24) NOT NULL CHECK (result IN ('SUCCESS', 'FAILURE')),
  reason_code VARCHAR(96),
  request_id VARCHAR(128),
  ip_address INET,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX license_events_license_time_idx
  ON license_events (license_key_id, occurred_at DESC) WHERE license_key_id IS NOT NULL;
CREATE INDEX license_events_tenant_time_idx
  ON license_events (tenant_id, occurred_at DESC);
CREATE INDEX license_events_type_time_idx
  ON license_events (event_type, occurred_at DESC);

CREATE TABLE signing_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id VARCHAR(96) NOT NULL UNIQUE,
  algorithm VARCHAR(32) NOT NULL CHECK (algorithm IN ('Ed25519')),
  provider VARCHAR(32) NOT NULL CHECK (provider IN ('KMS', 'HSM', 'FILE_DEV')),
  provider_key_reference TEXT NOT NULL,
  public_key_pem TEXT NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'ACTIVE', 'RETIRING', 'RETIRED', 'COMPROMISED')),
  activated_at TIMESTAMPTZ,
  retires_at TIMESTAMPTZ,
  created_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status <> 'ACTIVE' OR activated_at IS NOT NULL)
);

CREATE UNIQUE INDEX signing_keys_single_active_idx
  ON signing_keys ((status)) WHERE status = 'ACTIVE';

CREATE TABLE system_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope VARCHAR(24) NOT NULL CHECK (scope IN ('PLATFORM', 'TENANT', 'PRODUCT')),
  scope_id UUID,
  setting_key VARCHAR(128) NOT NULL,
  setting_value JSONB NOT NULL,
  is_sensitive BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (scope = 'PLATFORM' AND scope_id IS NULL)
    OR (scope IN ('TENANT', 'PRODUCT') AND scope_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX system_settings_scope_key_uidx
  ON system_settings (
    scope,
    COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::UUID),
    setting_key
  );

CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  actor_type VARCHAR(24) NOT NULL CHECK (actor_type IN ('ADMIN_USER', 'SYSTEM', 'API_CLIENT')),
  actor_id UUID,
  action VARCHAR(128) NOT NULL,
  resource_type VARCHAR(96) NOT NULL,
  resource_id VARCHAR(128),
  request_id VARCHAR(128),
  source_ip INET,
  user_agent TEXT,
  result VARCHAR(24) NOT NULL CHECK (result IN ('SUCCESS', 'FAILURE')),
  before_data JSONB,
  after_data JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX audit_logs_tenant_time_idx ON audit_logs (tenant_id, occurred_at DESC);
CREATE INDEX audit_logs_actor_time_idx ON audit_logs (actor_type, actor_id, occurred_at DESC);
CREATE INDEX audit_logs_resource_idx ON audit_logs (resource_type, resource_id, occurred_at DESC);

INSERT INTO permissions (code, name, description) VALUES
  ('platform.tenants.manage', '管理平台租户', '创建、冻结和维护平台租户'),
  ('admin.users.manage', '管理管理员', '管理租户内管理员账号'),
  ('admin.roles.manage', '管理角色权限', '管理角色和权限分配'),
  ('products.read', '查看产品', '查看产品、版本和功能定义'),
  ('products.write', '管理产品', '创建和修改产品、版本和功能定义'),
  ('licenses.read', '查看授权', '查看 Key、策略、设备和会话'),
  ('licenses.write', '管理授权', '生成、续期、冻结和吊销 Key'),
  ('licenses.export', '导出授权', '导出批量生成的授权交付数据'),
  ('devices.read', '查看设备', '查看授权绑定设备'),
  ('devices.unbind', '解绑设备', '执行管理员强制解绑'),
  ('devices.block', '封禁设备', '封禁或解除封禁设备'),
  ('audit.read', '查看审计日志', '读取管理员操作与授权审计记录'),
  ('settings.manage', '管理系统配置', '修改平台、租户和产品配置'),
  ('signing-keys.manage', '管理签名密钥', '执行签名密钥启用、轮换和退役')
ON CONFLICT (code) DO NOTHING;

CREATE TRIGGER tenants_set_updated_at
BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER admin_users_set_updated_at
BEFORE UPDATE ON admin_users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER roles_set_updated_at
BEFORE UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER products_set_updated_at
BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER api_clients_set_updated_at
BEFORE UPDATE ON api_clients FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER license_policies_set_updated_at
BEFORE UPDATE ON license_policies FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER license_keys_set_updated_at
BEFORE UPDATE ON license_keys FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER devices_set_updated_at
BEFORE UPDATE ON devices FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER activations_set_updated_at
BEFORE UPDATE ON activations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER feature_definitions_set_updated_at
BEFORE UPDATE ON feature_definitions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER feature_grants_set_updated_at
BEFORE UPDATE ON feature_grants FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER license_sessions_set_updated_at
BEFORE UPDATE ON license_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER signing_keys_set_updated_at
BEFORE UPDATE ON signing_keys FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER system_settings_set_updated_at
BEFORE UPDATE ON system_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

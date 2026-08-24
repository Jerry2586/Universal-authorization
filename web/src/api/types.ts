export interface AdminUser {
  id: string;
  email: string;
  display_name: string;
  tenant: { id: string; code: string | null; name: string | null } | null;
  permissions: string[];
  status: string;
  last_login_at: string | null;
  created_at: string;
  roles: Array<{ id: string; code: string; name: string }>;
}

export interface AuthPayload {
  admin: AdminUser;
  csrf_token: string;
  expires_at: string;
}

export type AdminStatus = 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
export interface ManagedAdmin {
  id: string; email: string; display_name: string; status: AdminStatus; mfa_required: boolean;
  last_login_at: string | null; password_changed_at: string | null; created_at: string; updated_at: string;
  roles: Array<{ id: string; code: string; name: string }>;
}
export interface AdminRole {
  id: string; code: string; name: string; description: string | null; is_system: boolean;
  permissions: string[]; user_count: number; created_at: string; updated_at: string;
}
export interface AdminPermission { code: string; name: string; description: string | null }
export interface TenantSettings {
  console_name: string; support_email: string; default_license_days: number;
  default_max_devices: number; expiry_warning_days: number; updated_at: string | null;
}
export type ProductStatus = 'ACTIVE' | 'DISABLED';
export type VersionStatus = 'ACTIVE' | 'BLOCKED' | 'DEPRECATED';
export type LicenseStatus = 'CREATED' | 'ACTIVE' | 'SUSPENDED' | 'EXPIRED' | 'REVOKED' | 'DISABLED';
export type LicenseType = 'TRIAL' | 'DURATION' | 'FIXED_EXPIRY' | 'PERPETUAL';
export type OperationResult = 'SUCCESS' | 'FAILURE';

export interface Product {
  id: string;
  tenant_id?: string;
  code: string;
  name: string;
  description: string | null;
  status: ProductStatus;
  minimum_client_version: string | null;
  recommended_client_version: string | null;
  force_update_version: string | null;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ProductVersion {
  id: string;
  product_id: string;
  version: string;
  status: VersionStatus;
  force_update: boolean;
  release_notes: string | null;
  released_at: string | null;
  created_at: string;
}

export interface Feature {
  id: string;
  product_id: string;
  code: string;
  name: string;
  description: string | null;
  status: ProductStatus;
  created_at: string;
  updated_at: string;
}

export interface Policy {
  id: string;
  tenant_id?: string;
  product_id: string | null;
  code: string;
  name: string;
  license_type: LicenseType;
  duration_seconds: number | null;
  max_devices: number;
  max_concurrent_sessions: number;
  offline_grace_seconds: number;
  allow_self_unbind: boolean;
  unbind_cooldown_seconds: number;
  rules: Record<string, unknown>;
  status: ProductStatus;
  created_at: string;
  updated_at: string;
}

export interface LicenseFeatureGrant {
  code: string;
  allowed: boolean;
  limits: Record<string, unknown>;
  expires_at: string | null;
}

export interface License {
  id: string;
  tenant_id?: string;
  product_id: string;
  policy_id: string | null;
  generation_batch_id: string | null;
  display_key: string;
  status: LicenseStatus;
  license_type: LicenseType;
  starts_at: string | null;
  expires_at: string | null;
  duration_seconds: number | null;
  max_devices: number;
  max_concurrent_sessions: number;
  offline_grace_seconds: number;
  allow_self_unbind: boolean;
  unbind_cooldown_seconds: number;
  metadata: Record<string, unknown>;
  features: LicenseFeatureGrant[];
  created_at: string;
  activated_at: string | null;
  revoked_at: string | null;
  updated_at: string;
}

export interface DeviceBinding {
  device_id: string;
  tenant_id: string;
  license_id: string;
  activation_id: string;
  device_status: string;
  activation_status: 'ACTIVE' | 'UNBOUND' | 'BLOCKED' | 'REPLACED';
  platform: string | null;
  os_version: string | null;
  display_name: string | null;
  device_public_key_fingerprint: string;
  fingerprint_hash: string;
  risk_score: number;
  first_seen_at: string;
  last_seen_at: string | null;
  activated_at: string;
  last_verified_at: string | null;
  unbound_at: string | null;
  active_session_count: number;
  blocked: boolean;
  block_reason: string | null;
  blocked_at: string | null;
}

export interface AuditItem {
  id: string;
  tenant_id?: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  request_id: string | null;
  source_ip: string | null;
  user_agent?: string | null;
  result: OperationResult;
  before_data?: Record<string, unknown> | null;
  after_data?: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  occurred_at: string;
}

export interface LicenseEvent {
  id: string;
  tenant_id?: string;
  product_id: string | null;
  license_id: string | null;
  device_id: string | null;
  activation_id?: string | null;
  session_id?: string | null;
  event_type: string;
  result: OperationResult;
  reason_code: string | null;
  request_id: string | null;
  ip_address: string | null;
  metadata: Record<string, unknown>;
  occurred_at: string;
}

export interface Page<T> {
  items: T[];
  limit: number;
  offset: number;
  total?: number;
}

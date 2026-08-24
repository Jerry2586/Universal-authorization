export const PERMISSIONS = {
  PLATFORM_TENANTS_MANAGE: 'platform.tenants.manage',
  ADMIN_USERS_MANAGE: 'admin.users.manage',
  ADMIN_ROLES_MANAGE: 'admin.roles.manage',
  PRODUCTS_READ: 'products.read',
  PRODUCTS_WRITE: 'products.write',
  LICENSES_READ: 'licenses.read',
  LICENSES_WRITE: 'licenses.write',
  LICENSES_EXPORT: 'licenses.export',
  DEVICES_READ: 'devices.read',
  DEVICES_UNBIND: 'devices.unbind',
  DEVICES_BLOCK: 'devices.block',
  AUDIT_READ: 'audit.read',
  SETTINGS_MANAGE: 'settings.manage',
  SIGNING_KEYS_MANAGE: 'signing-keys.manage',
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const PLATFORM_ONLY_PERMISSIONS: ReadonlySet<PermissionCode> = new Set([
  PERMISSIONS.PLATFORM_TENANTS_MANAGE,
  PERMISSIONS.SETTINGS_MANAGE,
  PERMISSIONS.SIGNING_KEYS_MANAGE,
]);

export interface PermissionSubject {
  /** 平台主体为 null，租户主体必须是其所属租户 ID。 */
  tenantId: string | null;
  permissions: ReadonlySet<string>;
}

export function hasAllPermissions(
  granted: ReadonlySet<string>,
  required: readonly PermissionCode[],
): boolean {
  return required.every((permission) => granted.has(permission));
}

/**
 * 检查租户资源权限。
 * 平台主体可以跨租户；租户主体只能访问自己的租户，并且不能使用平台专属权限。
 */
export function hasTenantPermissions(
  subject: PermissionSubject,
  targetTenantId: string,
  required: readonly PermissionCode[],
): boolean {
  if (!hasAllPermissions(subject.permissions, required)) {
    return false;
  }

  if (subject.tenantId === null) {
    return true;
  }

  return (
    subject.tenantId === targetTenantId
    && required.every((permission) => !PLATFORM_ONLY_PERMISSIONS.has(permission))
  );
}

/** 平台操作必须由平台主体执行，不能仅凭租户角色中误配的权限越权。 */
export function hasPlatformPermissions(
  subject: PermissionSubject,
  required: readonly PermissionCode[],
): boolean {
  return (
    subject.tenantId === null
    && required.every((permission) => PLATFORM_ONLY_PERMISSIONS.has(permission))
    && hasAllPermissions(subject.permissions, required)
  );
}

export function isPlatformOnlyPermission(permission: PermissionCode): boolean {
  return PLATFORM_ONLY_PERMISSIONS.has(permission);
}

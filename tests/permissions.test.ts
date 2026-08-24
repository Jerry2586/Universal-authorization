import { describe, expect, it } from 'vitest';
import {
  hasAllPermissions,
  hasPlatformPermissions,
  hasTenantPermissions,
  isPlatformOnlyPermission,
  PERMISSIONS,
} from '../src/modules/identity/domain/permissions.js';

describe('RBAC permission model', () => {
  it('requires every declared permission', () => {
    const granted = new Set<string>([
      PERMISSIONS.PRODUCTS_READ,
      PERMISSIONS.LICENSES_READ,
    ]);

    expect(
      hasAllPermissions(granted, [
        PERMISSIONS.PRODUCTS_READ,
        PERMISSIONS.LICENSES_READ,
      ]),
    ).toBe(true);
    expect(
      hasAllPermissions(granted, [
        PERMISSIONS.PRODUCTS_READ,
        PERMISSIONS.LICENSES_WRITE,
      ]),
    ).toBe(false);
  });

  it('allows a tenant subject to access only its own tenant', () => {
    const subject = {
      tenantId: 'tenant-a',
      permissions: new Set<string>([PERMISSIONS.PRODUCTS_READ]),
    };

    expect(
      hasTenantPermissions(subject, 'tenant-a', [PERMISSIONS.PRODUCTS_READ]),
    ).toBe(true);
    expect(
      hasTenantPermissions(subject, 'tenant-b', [PERMISSIONS.PRODUCTS_READ]),
    ).toBe(false);
  });

  it('allows a platform subject to operate across tenant boundaries', () => {
    const subject = {
      tenantId: null,
      permissions: new Set<string>([PERMISSIONS.PRODUCTS_WRITE]),
    };

    expect(
      hasTenantPermissions(subject, 'tenant-a', [PERMISSIONS.PRODUCTS_WRITE]),
    ).toBe(true);
    expect(
      hasTenantPermissions(subject, 'tenant-b', [PERMISSIONS.PRODUCTS_WRITE]),
    ).toBe(true);
  });

  it('does not allow tenant subjects to use platform-only permissions', () => {
    const subject = {
      tenantId: 'tenant-a',
      permissions: new Set<string>([
        PERMISSIONS.PLATFORM_TENANTS_MANAGE,
        PERMISSIONS.SETTINGS_MANAGE,
        PERMISSIONS.SIGNING_KEYS_MANAGE,
      ]),
    };

    expect(
      hasPlatformPermissions(subject, [PERMISSIONS.PLATFORM_TENANTS_MANAGE]),
    ).toBe(false);
    expect(
      hasTenantPermissions(subject, 'tenant-a', [PERMISSIONS.SIGNING_KEYS_MANAGE]),
    ).toBe(false);
  });

  it('requires platform operations to request platform-only permissions', () => {
    const subject = {
      tenantId: null,
      permissions: new Set<string>([
        PERMISSIONS.PLATFORM_TENANTS_MANAGE,
        PERMISSIONS.PRODUCTS_READ,
      ]),
    };

    expect(
      hasPlatformPermissions(subject, [PERMISSIONS.PLATFORM_TENANTS_MANAGE]),
    ).toBe(true);
    expect(
      hasPlatformPermissions(subject, [PERMISSIONS.PRODUCTS_READ]),
    ).toBe(false);
    expect(isPlatformOnlyPermission(PERMISSIONS.SETTINGS_MANAGE)).toBe(true);
    expect(isPlatformOnlyPermission(PERMISSIONS.PRODUCTS_READ)).toBe(false);
  });
});

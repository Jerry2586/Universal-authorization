import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AppError } from '../src/shared/errors/app-error.js';
import type { AdminPrincipalResolver } from '../src/modules/identity/admin-principal.js';
import { PERMISSIONS } from '../src/modules/identity/domain/permissions.js';
import type { AdminConsoleService } from '../src/modules/admin-console/admin-console.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const adminId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let app: FastifyInstance | undefined;
afterEach(async () => { if (app !== undefined) { await app.close(); app = undefined; } });

function dependencies(
  permissions: ReadonlySet<string>,
  serviceMethods: Record<string, unknown>,
  principalTenantId: string | null = tenantId,
) {
  const principalResolver: AdminPrincipalResolver = {
    resolve: async (input) => {
      if (input.csrfRequired && input.csrfToken !== 'csrf-token') {
        throw new AppError({ code: 'ADMIN_CSRF_INVALID', message: '安全校验失败', statusCode: 403 });
      }
      return { userId: adminId, tenantId: principalTenantId, permissions };
    },
  };
  return { principalResolver, service: serviceMethods as unknown as AdminConsoleService, secureCookie: false };
}

function role() {
  const now = new Date('2026-08-24T00:00:00.000Z');
  return { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', code: 'auditor', name: '审计员', description: null, isSystem: false, permissions: ['audit.read'], userCount: 1, createdAt: now, updatedAt: now };
}

describe('管理后台成熟化路由', () => {
  it('仅拥有角色管理权限也可以读取角色列表', async () => {
    app = buildApp({ adminConsole: dependencies(new Set([PERMISSIONS.ADMIN_ROLES_MANAGE]), { listRoles: async () => [role()] }) });
    const response = await app.inject({ method: 'GET', url: '/admin/v1/admin-roles', headers: { authorization: 'Bearer test', 'x-admin-user-id': adminId } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ success: true, data: { items: [{ code: 'auditor', user_count: 1 }] } });
  });

  it('Cookie 会话执行写操作时必须携带 CSRF 令牌', async () => {
    let called = false;
    app = buildApp({ adminConsole: dependencies(new Set([PERMISSIONS.TENANT_SETTINGS_MANAGE]), { updateTenantSettings: async () => { called = true; } }) });
    const response = await app.inject({
      method: 'PUT', url: '/admin/v1/settings/tenant',
      headers: { cookie: 'ua_admin_session=a-valid-session-token-long-enough', origin: 'http://localhost', host: 'localhost' },
      payload: { console_name: '授权中心', support_email: '', default_license_days: 30, default_max_devices: 1, expiry_warning_days: 7 },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'ADMIN_CSRF_INVALID' });
    expect(called).toBe(false);
  });

  it('平台管理员修改个人资料时不要求指定目标租户', async () => {
    const now = new Date('2026-08-24T00:00:00.000Z');
    let receivedTenantId: string | null | undefined;
    app = buildApp({ adminConsole: dependencies(new Set(), {
      updateOwnProfile: async (context: { tenantId: string | null }) => {
        receivedTenantId = context.tenantId;
        return {
          id: adminId,
          email: 'platform@example.com',
          displayName: '平台管理员',
          status: 'ACTIVE',
          mfaRequired: false,
          lastLoginAt: null,
          passwordChangedAt: null,
          createdAt: now,
          updatedAt: now,
          roles: [],
        };
      },
    }, null) });
    const response = await app.inject({
      method: 'PATCH',
      url: '/admin/v1/profile',
      headers: {
        cookie: 'ua_admin_session=a-valid-session-token-long-enough',
        'x-csrf-token': 'csrf-token',
        origin: 'http://localhost',
        host: 'localhost',
      },
      payload: { display_name: '平台管理员' },
    });
    expect(response.statusCode).toBe(200);
    expect(receivedTenantId).toBeNull();
    expect(response.json()).toMatchObject({ data: { email: 'platform@example.com', display_name: '平台管理员' } });
  });

  it('管理员列表返回真实总数用于完整分页', async () => {
    const now = new Date('2026-08-24T00:00:00.000Z');
    app = buildApp({ adminConsole: dependencies(new Set([PERMISSIONS.ADMIN_USERS_MANAGE]), {
      listAdmins: async () => ({ items: [{ id: adminId, email: 'admin@example.com', displayName: '管理员', status: 'ACTIVE', mfaRequired: false, lastLoginAt: null, passwordChangedAt: null, createdAt: now, updatedAt: now, roles: [] }], total: 37 }),
    }) });
    const response = await app.inject({ method: 'GET', url: '/admin/v1/admin-users?limit=20&offset=0', headers: { authorization: 'Bearer test', 'x-admin-user-id': adminId } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { total: 37, limit: 20, offset: 0, items: [{ email: 'admin@example.com' }] } });
  });

  it('管理员状态筛选会原样传入真实列表服务', async () => {
    let receivedStatus: string | undefined;
    app = buildApp({ adminConsole: dependencies(new Set([PERMISSIONS.ADMIN_USERS_MANAGE]), {
      listAdmins: async (_context: unknown, input: { status?: string }) => {
        receivedStatus = input.status;
        return { items: [], total: 0 };
      },
    }) });

    const response = await app.inject({
      method: 'GET',
      url: '/admin/v1/admin-users?status=SUSPENDED&limit=20&offset=0',
      headers: { authorization: 'Bearer test', 'x-admin-user-id': adminId },
    });

    expect(response.statusCode).toBe(200);
    expect(receivedStatus).toBe('SUSPENDED');
    expect(response.json()).toMatchObject({ data: { items: [], total: 0 } });
  });

  it('创建管理员时拒绝重复角色，且不会调用业务服务', async () => {
    let called = false;
    const roleId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    app = buildApp({ adminConsole: dependencies(new Set([PERMISSIONS.ADMIN_USERS_MANAGE]), {
      createAdmin: async () => { called = true; },
    }) });

    const response = await app.inject({
      method: 'POST',
      url: '/admin/v1/admin-users',
      headers: { authorization: 'Bearer test', 'x-admin-user-id': adminId },
      payload: {
        email: 'new-admin@example.com',
        display_name: '新管理员',
        password: 'StrongPassword123',
        role_ids: [roleId, roleId],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(called).toBe(false);
  });

  it('创建角色时拒绝重复权限，且不会调用业务服务', async () => {
    let called = false;
    app = buildApp({ adminConsole: dependencies(new Set([PERMISSIONS.ADMIN_ROLES_MANAGE]), {
      createRole: async () => { called = true; },
    }) });

    const response = await app.inject({
      method: 'POST',
      url: '/admin/v1/admin-roles',
      headers: { authorization: 'Bearer test', 'x-admin-user-id': adminId },
      payload: {
        code: 'support',
        name: '客服管理员',
        permissions: ['licenses.read', 'licenses.read'],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(called).toBe(false);
  });

  it('更新角色时拒绝重复权限，且不会调用业务服务', async () => {
    let called = false;
    app = buildApp({ adminConsole: dependencies(new Set([PERMISSIONS.ADMIN_ROLES_MANAGE]), {
      updateRole: async () => { called = true; },
    }) });

    const response = await app.inject({
      method: 'PATCH',
      url: '/admin/v1/admin-roles/cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      headers: { authorization: 'Bearer test', 'x-admin-user-id': adminId },
      payload: { permissions: ['audit.read', 'audit.read'] },
    });

    expect(response.statusCode).toBe(400);
    expect(called).toBe(false);
  });
});

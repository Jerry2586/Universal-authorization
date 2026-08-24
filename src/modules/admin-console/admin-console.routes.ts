import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ADMIN_SESSION_COOKIE, clearSessionCookie, parseCookie } from '../admin-auth/admin-cookie.js';
import type { AdminPrincipalResolver } from '../identity/admin-principal.js';
import { PERMISSIONS } from '../identity/domain/permissions.js';
import {
  requireAnyManagementContext,
  requireAuthenticatedAdminContext,
  requireManagementContext,
} from '../../shared/management/management-context.js';
import { successResponse } from '../../shared/http/api-response.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { AdminConsoleService } from './admin-console.service.js';
import type { AdminRoleView, ManagedAdminView, TenantSettingsView } from './admin-console.repository.js';

export interface AdminConsoleRouteDependencies {
  principalResolver: AdminPrincipalResolver;
  service: AdminConsoleService;
  secureCookie: boolean;
}

const uuid = z.string().uuid();
const adminStatus = z.enum(['ACTIVE', 'SUSPENDED', 'DISABLED']);
const pageSchema = z.object({ search: z.string().trim().max(120).optional(), status: adminStatus.optional(), limit: z.coerce.number().int().min(1).max(100).default(20), offset: z.coerce.number().int().min(0).default(0) });
const password = z.string().min(12).max(256).regex(/[a-z]/, '至少包含一个小写字母').regex(/[A-Z]/, '至少包含一个大写字母').regex(/[0-9]/, '至少包含一个数字');
const roleIds = z.array(uuid).min(1).max(20).refine((values) => new Set(values).size === values.length, '角色不能重复选择');
const permissionCodes = z.array(z.string().min(2).max(96)).max(100).refine((values) => new Set(values).size === values.length, '权限代码不能重复');
const createAdminSchema = z.object({ email: z.string().trim().email().max(320), display_name: z.string().trim().min(2).max(120), password, role_ids: roleIds });
const updateAdminSchema = z.object({ email: z.string().trim().email().max(320).optional(), display_name: z.string().trim().min(2).max(120).optional(), status: adminStatus.optional(), role_ids: roleIds.optional() }).refine((value) => Object.keys(value).length > 0, '至少提交一个修改字段');
const roleSchema = z.object({ code: z.string().trim().min(2).max(64).regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/), name: z.string().trim().min(2).max(120), description: z.string().trim().max(500).optional(), permissions: permissionCodes });
const roleUpdateSchema = z.object({ name: z.string().trim().min(2).max(120).optional(), description: z.string().trim().max(500).nullable().optional(), permissions: permissionCodes.optional() }).refine((value) => Object.keys(value).length > 0, '至少提交一个修改字段');
const settingsSchema = z.object({ console_name: z.string().trim().min(2).max(80), support_email: z.union([z.literal(''), z.string().trim().email().max(320)]), default_license_days: z.number().int().min(1).max(36500), default_max_devices: z.number().int().min(1).max(1000), expiry_warning_days: z.number().int().min(1).max(365) });

export function registerAdminConsoleRoutes(app: FastifyInstance, dependencies: AdminConsoleRouteDependencies): void {
  app.get('/admin/v1/admin-users', async (request) => {
    const context = await requireManagementContext(request, dependencies.principalResolver, [PERMISSIONS.ADMIN_USERS_MANAGE]);
    const query = pageSchema.parse(request.query);
    const page = await dependencies.service.listAdmins(context, { limit: query.limit, offset: query.offset, ...(query.search === undefined ? {} : { search: query.search }), ...(query.status === undefined ? {} : { status: query.status }) });
    return successResponse(request.id, { items: page.items.map(adminResponse), total: page.total, limit: query.limit, offset: query.offset }, '管理员列表读取成功');
  });

  app.post('/admin/v1/admin-users', async (request, reply) => {
    const context = await requireManagementContext(request, dependencies.principalResolver, [PERMISSIONS.ADMIN_USERS_MANAGE]);
    const body = createAdminSchema.parse(request.body);
    const admin = await dependencies.service.createAdmin(context, { email: body.email, displayName: body.display_name, password: body.password, roleIds: body.role_ids });
    return reply.status(201).send(successResponse(request.id, adminResponse(admin), '管理员创建成功'));
  });

  app.patch('/admin/v1/admin-users/:adminId', async (request) => {
    const context = await requireManagementContext(request, dependencies.principalResolver, [PERMISSIONS.ADMIN_USERS_MANAGE]);
    const params = z.object({ adminId: uuid }).parse(request.params); const body = updateAdminSchema.parse(request.body);
    const admin = await dependencies.service.updateAdmin(context, params.adminId, { ...(body.email === undefined ? {} : { email: body.email }), ...(body.display_name === undefined ? {} : { displayName: body.display_name }), ...(body.status === undefined ? {} : { status: body.status }), ...(body.role_ids === undefined ? {} : { roleIds: body.role_ids }) });
    return successResponse(request.id, adminResponse(admin), '管理员更新成功');
  });

  app.post('/admin/v1/admin-users/:adminId/reset-password', async (request) => {
    const context = await requireManagementContext(request, dependencies.principalResolver, [PERMISSIONS.ADMIN_USERS_MANAGE]);
    const params = z.object({ adminId: uuid }).parse(request.params); const body = z.object({ new_password: password }).parse(request.body);
    return successResponse(request.id, await dependencies.service.resetPassword(context, params.adminId, body.new_password), '密码已重置，该管理员需要重新登录');
  });

  app.patch('/admin/v1/profile', async (request) => {
    const context = await requireAuthenticatedAdminContext(request, dependencies.principalResolver);
    const body = z.object({ display_name: z.string().trim().min(2).max(120) }).parse(request.body);
    return successResponse(request.id, adminResponse(await dependencies.service.updateOwnProfile(context, body.display_name)), '个人资料更新成功');
  });

  app.post('/admin/v1/profile/change-password', async (request, reply) => {
    const context = await requireAuthenticatedAdminContext(request, dependencies.principalResolver);
    const body = z.object({ current_password: z.string().min(8).max(256), new_password: password }).parse(request.body);
    const token = sessionToken(request);
    const result = await dependencies.service.changeOwnPassword(context, token, body.current_password, body.new_password);
    reply.header('set-cookie', clearSessionCookie(dependencies.secureCookie));
    reply.header('cache-control', 'no-store');
    return successResponse(request.id, { changed: result.changed, login_required: result.loginRequired }, '密码修改成功，请重新登录');
  });

  app.get('/admin/v1/admin-roles', async (request) => {
    const context = await requireAnyManagementContext(request, dependencies.principalResolver, [PERMISSIONS.ADMIN_USERS_MANAGE, PERMISSIONS.ADMIN_ROLES_MANAGE]);
    return successResponse(request.id, { items: (await dependencies.service.listRoles(context)).map(roleResponse) }, '角色列表读取成功');
  });
  app.get('/admin/v1/admin-permissions', async (request) => {
    await requireManagementContext(request, dependencies.principalResolver, [PERMISSIONS.ADMIN_ROLES_MANAGE]);
    return successResponse(request.id, { items: await dependencies.service.listPermissions() }, '权限目录读取成功');
  });
  app.post('/admin/v1/admin-roles', async (request, reply) => {
    const context = await requireManagementContext(request, dependencies.principalResolver, [PERMISSIONS.ADMIN_ROLES_MANAGE]); const body = roleSchema.parse(request.body);
    const role = await dependencies.service.createRole(context, { code: body.code, name: body.name, permissions: body.permissions, ...(body.description === undefined ? {} : { description: body.description }) });
    return reply.status(201).send(successResponse(request.id, roleResponse(role), '角色创建成功'));
  });
  app.patch('/admin/v1/admin-roles/:roleId', async (request) => {
    const context = await requireManagementContext(request, dependencies.principalResolver, [PERMISSIONS.ADMIN_ROLES_MANAGE]); const params = z.object({ roleId: uuid }).parse(request.params); const body = roleUpdateSchema.parse(request.body);
    const role = await dependencies.service.updateRole(context, params.roleId, { ...(body.name === undefined ? {} : { name: body.name }), ...(body.description === undefined ? {} : { description: body.description }), ...(body.permissions === undefined ? {} : { permissions: body.permissions }) });
    return successResponse(request.id, roleResponse(role), '角色更新成功');
  });

  app.get('/admin/v1/settings/tenant', async (request) => {
    const context = await requireManagementContext(request, dependencies.principalResolver, [PERMISSIONS.TENANT_SETTINGS_MANAGE]);
    return successResponse(request.id, settingsResponse(await dependencies.service.getTenantSettings(context)), '工作区设置读取成功');
  });
  app.put('/admin/v1/settings/tenant', async (request) => {
    const context = await requireManagementContext(request, dependencies.principalResolver, [PERMISSIONS.TENANT_SETTINGS_MANAGE]); const body = settingsSchema.parse(request.body);
    const settings = await dependencies.service.updateTenantSettings(context, { consoleName: body.console_name, supportEmail: body.support_email, defaultLicenseDays: body.default_license_days, defaultMaxDevices: body.default_max_devices, expiryWarningDays: body.expiry_warning_days });
    return successResponse(request.id, settingsResponse(settings), '工作区设置保存成功');
  });
}

function sessionToken(request: FastifyRequest): string { const token = parseCookie(header(request, 'cookie'), ADMIN_SESSION_COOKIE); if (token === undefined) throw new AppError({ code: 'ADMIN_SESSION_INVALID', message: '请先登录管理后台', statusCode: 401 }); return token; }
function header(request: FastifyRequest, name: string): string | undefined { const value = request.headers[name]; return Array.isArray(value) ? value[0] : value; }
function adminResponse(admin: ManagedAdminView) { return { id: admin.id, email: admin.email, display_name: admin.displayName, status: admin.status, mfa_required: admin.mfaRequired, last_login_at: admin.lastLoginAt?.toISOString() ?? null, password_changed_at: admin.passwordChangedAt?.toISOString() ?? null, created_at: admin.createdAt.toISOString(), updated_at: admin.updatedAt.toISOString(), roles: admin.roles }; }
function roleResponse(role: AdminRoleView) { return { id: role.id, code: role.code, name: role.name, description: role.description, is_system: role.isSystem, permissions: role.permissions, user_count: role.userCount, created_at: role.createdAt.toISOString(), updated_at: role.updatedAt.toISOString() }; }
function settingsResponse(settings: TenantSettingsView) { return { console_name: settings.consoleName, support_email: settings.supportEmail, default_license_days: settings.defaultLicenseDays, default_max_devices: settings.defaultMaxDevices, expiry_warning_days: settings.expiryWarningDays, updated_at: settings.updatedAt?.toISOString() ?? null }; }

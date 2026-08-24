import type { AuditLogPort } from '../audit/audit-log.port.js';
import { AppError } from '../../shared/errors/app-error.js';
import { hashAdminPassword, verifyAdminPassword } from '../admin-auth/admin-password.js';
import type { AdminSessionStore } from '../admin-auth/admin-session.store.js';
import type { AuthenticatedAdminRequestContext, ManagementRequestContext } from '../identity/admin-principal.js';
import type { AdminConsoleRepository, AdminStatus, TenantSettingsView } from './admin-console.repository.js';

export class AdminConsoleService {
  public constructor(
    private readonly repository: AdminConsoleRepository,
    private readonly sessions: AdminSessionStore,
    private readonly auditLog: AuditLogPort,
  ) {}

  public listAdmins(context: ManagementRequestContext, input: { search?: string; status?: AdminStatus; limit: number; offset: number }) {
    return this.repository.listAdmins(context.tenantId, input);
  }

  public async createAdmin(context: ManagementRequestContext, input: { email: string; displayName: string; password: string; roleIds: string[] }) {
    const passwordHash = await hashAdminPassword(input.password);
    const admin = await this.repository.createAdmin({ tenantId: context.tenantId, email: input.email, displayName: input.displayName, passwordHash, roleIds: input.roleIds, actorId: context.principal.userId });
    await this.audit(context, 'ADMIN_USER_CREATE', 'ADMIN_USER', admin.id, undefined, sanitizeAdmin(admin));
    return admin;
  }

  public async updateAdmin(context: ManagementRequestContext, adminId: string, input: { email?: string; displayName?: string; status?: AdminStatus; roleIds?: string[] }) {
    if (adminId === context.principal.userId && (input.status !== undefined && input.status !== 'ACTIVE' || input.roleIds !== undefined)) {
      throw new AppError({ code: 'SELF_LOCKOUT_FORBIDDEN', message: '不能停用自己或修改自己的角色，请由其他所有者操作', statusCode: 409 });
    }
    const changed = await this.repository.updateAdmin({ tenantId: context.tenantId, adminId, actorId: context.principal.userId, ...input });
    await this.audit(context, 'ADMIN_USER_UPDATE', 'ADMIN_USER', adminId, sanitizeAdmin(changed.before), sanitizeAdmin(changed.after));
    return changed.after;
  }

  public async resetPassword(context: ManagementRequestContext, adminId: string, newPassword: string) {
    if (adminId === context.principal.userId) throw new AppError({ code: 'USE_CHANGE_PASSWORD', message: '修改自己的密码请使用个人中心', statusCode: 409 });
    const target = await this.repository.findAdmin(context.tenantId, adminId);
    if (target === null) throw new AppError({ code: 'RESOURCE_NOT_FOUND', message: '管理员不存在', statusCode: 404 });
    const passwordHash = await hashAdminPassword(newPassword);
    await this.repository.replacePassword(adminId, passwordHash);
    await this.audit(context, 'ADMIN_PASSWORD_RESET', 'ADMIN_USER', adminId, undefined, { session_invalidated: true });
    return { reset: true, sessionInvalidated: true };
  }

  public async updateOwnProfile(context: AuthenticatedAdminRequestContext, displayName: string) {
    const before = await this.repository.findAdminById(context.principal.userId);
    const after = await this.repository.updateOwnProfile(context.principal.userId, displayName);
    await this.audit(context, 'ADMIN_PROFILE_UPDATE', 'ADMIN_USER', context.principal.userId, before === null ? undefined : sanitizeAdmin(before), sanitizeAdmin(after));
    return after;
  }

  public async changeOwnPassword(context: AuthenticatedAdminRequestContext, sessionToken: string, currentPassword: string, newPassword: string) {
    const record = await this.repository.passwordRecord(context.principal.userId);
    if (record === null || !await verifyAdminPassword(currentPassword, record.password_hash)) {
      throw new AppError({ code: 'CURRENT_PASSWORD_INVALID', message: '当前密码不正确', statusCode: 400 });
    }
    if (await verifyAdminPassword(newPassword, record.password_hash)) {
      throw new AppError({ code: 'PASSWORD_NOT_CHANGED', message: '新密码不能与当前密码相同', statusCode: 400 });
    }
    const passwordHash = await hashAdminPassword(newPassword);
    await this.repository.replacePassword(context.principal.userId, passwordHash);
    await this.sessions.destroy(sessionToken);
    await this.audit(context, 'ADMIN_PASSWORD_CHANGE', 'ADMIN_USER', context.principal.userId, undefined, { session_invalidated: true });
    return { changed: true, loginRequired: true };
  }

  public listRoles(context: ManagementRequestContext) { return this.repository.listRoles(context.tenantId); }
  public listPermissions() { return this.repository.listPermissions(); }

  public async createRole(context: ManagementRequestContext, input: { code: string; name: string; description?: string; permissions: string[] }) {
    const role = await this.repository.createRole({ tenantId: context.tenantId, ...input });
    await this.audit(context, 'ADMIN_ROLE_CREATE', 'ADMIN_ROLE', role.id, undefined, sanitizeRole(role));
    return role;
  }

  public async updateRole(context: ManagementRequestContext, roleId: string, input: { name?: string; description?: string | null; permissions?: string[] }) {
    const before = (await this.repository.listRoles(context.tenantId)).find((role) => role.id === roleId);
    const after = await this.repository.updateRole({ tenantId: context.tenantId, roleId, ...input });
    await this.audit(context, 'ADMIN_ROLE_UPDATE', 'ADMIN_ROLE', roleId, before === undefined ? undefined : sanitizeRole(before), sanitizeRole(after));
    return after;
  }

  public getTenantSettings(context: ManagementRequestContext) { return this.repository.getTenantSettings(context.tenantId); }

  public async updateTenantSettings(context: ManagementRequestContext, input: Omit<TenantSettingsView, 'updatedAt'>) {
    const before = await this.repository.getTenantSettings(context.tenantId);
    const after = await this.repository.updateTenantSettings(context.tenantId, context.principal.userId, input);
    await this.audit(context, 'TENANT_SETTINGS_UPDATE', 'TENANT_SETTINGS', context.tenantId, settingsData(before), settingsData(after));
    return after;
  }

  private async audit(context: AuthenticatedAdminRequestContext, action: string, resourceType: string, resourceId: string, before?: Record<string, unknown>, after?: Record<string, unknown>) {
    await this.auditLog.append({
      actor: {
        type: 'ADMIN_USER',
        id: context.principal.userId,
        ...(context.tenantId === null ? {} : { tenantId: context.tenantId }),
      },
      action, resourceType, resourceId, requestId: context.requestId,
      ...(context.sourceIp === undefined ? {} : { sourceIp: context.sourceIp }),
      ...(context.userAgent === undefined ? {} : { userAgent: context.userAgent }),
      result: 'SUCCESS', ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }), occurredAt: new Date(),
    });
  }
}

function sanitizeAdmin(admin: { email: string; displayName: string; status: string; roles: Array<{ code: string }> }): Record<string, unknown> { return { email: admin.email, display_name: admin.displayName, status: admin.status, roles: admin.roles.map((role) => role.code) }; }
function sanitizeRole(role: { code: string; name: string; permissions: string[] }): Record<string, unknown> { return { code: role.code, name: role.name, permissions: role.permissions }; }
function settingsData(settings: TenantSettingsView): Record<string, unknown> { return { console_name: settings.consoleName, support_email: settings.supportEmail, default_license_days: settings.defaultLicenseDays, default_max_devices: settings.defaultMaxDevices, expiry_warning_days: settings.expiryWarningDays }; }

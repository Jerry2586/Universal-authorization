import type { AuditLogPort } from '../audit/audit-log.port.js';
import { AppError } from '../../shared/errors/app-error.js';
import { fakePasswordVerification, verifyAdminPassword } from './admin-password.js';
import type { AdminAuthRepository, AdminView } from './admin-auth.repository.js';
import type { AdminSessionStore, CreatedAdminSession } from './admin-session.store.js';

export interface AdminLoginInput {
  email: string;
  password: string;
  tenantCode?: string;
  requestId: string;
  sourceIp: string;
  userAgent?: string;
}

export class AdminAuthService {
  private readonly maxFailures = 8;
  private readonly failureWindowSeconds = 15 * 60;

  public constructor(
    private readonly repository: AdminAuthRepository,
    private readonly sessions: AdminSessionStore,
    private readonly auditLog: AuditLogPort,
  ) {}

  public async login(input: AdminLoginInput): Promise<{ session: CreatedAdminSession; admin: AdminView }> {
    const accountIdentity = `${input.tenantCode ?? '-'}:${input.email.toLowerCase()}`;
    const [ipFailures, accountFailures] = await Promise.all([
      this.sessions.failureCount('ip', input.sourceIp),
      this.sessions.failureCount('account', accountIdentity),
    ]);
    if (ipFailures >= this.maxFailures || accountFailures >= this.maxFailures) {
      throw new AppError({ code: 'ADMIN_LOGIN_RATE_LIMITED', message: '登录尝试过多，请稍后再试', statusCode: 429, retryable: true });
    }

    const record = await this.repository.findForLogin(input.email, input.tenantCode);
    const passwordValid = record === null
      ? (await fakePasswordVerification(input.password), false)
      : await verifyAdminPassword(input.password, record.passwordHash);

    if (record === null || !passwordValid || record.status !== 'ACTIVE' || (record.tenantId !== null && record.tenantStatus !== 'ACTIVE')) {
      await Promise.all([
        this.sessions.registerFailure('ip', input.sourceIp, this.failureWindowSeconds),
        this.sessions.registerFailure('account', accountIdentity, this.failureWindowSeconds),
      ]);
      await this.auditLog.append({
        actor: { type: 'SYSTEM', ...(record?.tenantId === null || record?.tenantId === undefined ? {} : { tenantId: record.tenantId }) },
        action: 'ADMIN_LOGIN', resourceType: 'ADMIN_SESSION', requestId: input.requestId,
        sourceIp: input.sourceIp, ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
        result: 'FAILURE', metadata: { email_hint: maskEmail(input.email), reason: 'INVALID_CREDENTIALS' }, occurredAt: new Date(),
      });
      throw new AppError({ code: 'ADMIN_LOGIN_FAILED', message: '账号、密码或工作区不正确', statusCode: 401 });
    }

    if (record.mfaRequired) {
      throw new AppError({ code: 'ADMIN_MFA_REQUIRED', message: '该账号要求多因素认证，当前管理后台暂未启用此功能', statusCode: 403 });
    }

    const admin = await this.repository.getAdminView(record.id);
    if (admin === null) throw new AppError({ code: 'ADMIN_LOGIN_FAILED', message: '账号、密码或工作区不正确', statusCode: 401 });
    const session = await this.sessions.create(record.id, record.sessionVersion);
    await Promise.all([
      this.repository.updateLastLogin(record.id),
      this.sessions.clearFailures('account', accountIdentity),
      this.auditLog.append({
        actor: { type: 'ADMIN_USER', id: record.id, ...(record.tenantId === null ? {} : { tenantId: record.tenantId }) },
        action: 'ADMIN_LOGIN', resourceType: 'ADMIN_SESSION', resourceId: record.id, requestId: input.requestId,
        sourceIp: input.sourceIp, ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }), result: 'SUCCESS', occurredAt: new Date(),
      }),
    ]);
    return { session, admin };
  }

  public async current(sessionToken: string): Promise<{ session: Awaited<ReturnType<AdminSessionStore['require']>>; admin: AdminView }> {
    const session = await this.sessions.require(sessionToken);
    const admin = await this.repository.getAdminView(session.userId);
    if (admin === null || admin.sessionVersion !== session.sessionVersion) {
      await this.sessions.destroy(sessionToken);
      throw new AppError({ code: 'ADMIN_SESSION_INVALID', message: '登录已失效，请重新登录', statusCode: 401 });
    }
    return { session, admin };
  }

  public async logout(sessionToken: string, request: { requestId: string; sourceIp: string; userAgent?: string; csrfToken?: string }): Promise<void> {
    const session = await this.sessions.require(sessionToken, request.csrfToken);
    const admin = await this.repository.getAdminView(session.userId);
    await this.sessions.destroy(sessionToken);
    await this.auditLog.append({
      actor: { type: 'ADMIN_USER', id: session.userId, ...(admin?.tenantId === null || admin?.tenantId === undefined ? {} : { tenantId: admin.tenantId }) },
      action: 'ADMIN_LOGOUT', resourceType: 'ADMIN_SESSION', resourceId: session.userId, requestId: request.requestId,
      sourceIp: request.sourceIp, ...(request.userAgent === undefined ? {} : { userAgent: request.userAgent }), result: 'SUCCESS', occurredAt: new Date(),
    });
  }
}

function maskEmail(email: string): string {
  const [name = '', domain = ''] = email.split('@');
  return `${name.slice(0, 2)}***@${domain}`;
}

import { timingSafeEqual } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { PostgresDatabase } from '../../../infrastructure/database/postgres-database.js';
import { AppError } from '../../../shared/errors/app-error.js';
import type { AdminSessionStore } from '../../admin-auth/admin-session.store.js';
import type { AdminPrincipal, AdminPrincipalRequest, AdminPrincipalResolver } from '../admin-principal.js';

interface PrincipalRow extends QueryResultRow {
  user_id: string;
  tenant_id: string | null;
  session_version: number;
  permission_code: string | null;
}

export class PostgresAdminPrincipalResolver implements AdminPrincipalResolver {
  public constructor(
    private readonly database: PostgresDatabase,
    private readonly gatewayToken?: string,
    private readonly sessions?: AdminSessionStore,
  ) {}

  public async resolve(request: AdminPrincipalRequest): Promise<AdminPrincipal> {
    const bearer = this.bearerToken(request.authorization);
    if (bearer !== undefined) {
      if (this.gatewayToken === undefined || !this.tokensEqual(bearer, this.gatewayToken) || request.adminUserId === undefined) {
        throw unauthorized();
      }
      return this.loadPrincipal(request.adminUserId);
    }

    if (request.sessionToken !== undefined && this.sessions !== undefined) {
      if (request.csrfRequired === true && request.csrfToken === undefined) {
        throw new AppError({ code: 'ADMIN_CSRF_INVALID', message: '缺少安全令牌，请刷新页面后重试', statusCode: 403 });
      }
      const session = await this.sessions.require(
        request.sessionToken,
        request.csrfRequired === true ? request.csrfToken : undefined,
      );
      return this.loadPrincipal(session.userId, session.sessionVersion);
    }

    if (this.gatewayToken === undefined && this.sessions === undefined) {
      throw new AppError({ code: 'MANAGEMENT_API_NOT_CONFIGURED', message: '管理 API 尚未配置安全认证', statusCode: 503 });
    }
    throw unauthorized();
  }

  private async loadPrincipal(userId: string, expectedSessionVersion?: number): Promise<AdminPrincipal> {
    const result = await this.database.query<PrincipalRow>(
      `SELECT admin.id AS user_id, admin.tenant_id, admin.session_version, permission.code AS permission_code
         FROM admin_users admin
         LEFT JOIN tenants tenant ON tenant.id = admin.tenant_id
         LEFT JOIN admin_user_roles assignment ON assignment.admin_user_id = admin.id
         LEFT JOIN roles role ON role.id = assignment.role_id
           AND ((admin.tenant_id IS NULL AND role.scope = 'PLATFORM' AND role.tenant_id IS NULL)
             OR (admin.tenant_id IS NOT NULL AND role.scope = 'TENANT' AND role.tenant_id = admin.tenant_id))
         LEFT JOIN role_permissions role_permission ON role_permission.role_id = role.id
         LEFT JOIN permissions permission ON permission.code = role_permission.permission_code
        WHERE admin.id = $1 AND admin.status = 'ACTIVE'
          AND (admin.tenant_id IS NULL OR tenant.status = 'ACTIVE')`,
      [userId],
    );
    const first = result.rows[0];
    if (first === undefined || (expectedSessionVersion !== undefined && first.session_version !== expectedSessionVersion)) throw unauthorized('管理员不存在、已停用或会话已失效');
    return {
      userId: first.user_id,
      tenantId: first.tenant_id,
      permissions: new Set(result.rows.flatMap((row) => row.permission_code === null ? [] : [row.permission_code])),
    };
  }

  private bearerToken(authorization?: string): string | undefined {
    if (authorization === undefined) return undefined;
    return /^Bearer\s+(.+)$/i.exec(authorization.trim())?.[1];
  }

  private tokensEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
  }
}

function unauthorized(message = '管理端身份验证失败'): AppError {
  return new AppError({ code: 'ADMIN_UNAUTHORIZED', message, statusCode: 401 });
}

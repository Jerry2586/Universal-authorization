import { timingSafeEqual } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { PostgresDatabase } from '../../../infrastructure/database/postgres-database.js';
import { AppError } from '../../../shared/errors/app-error.js';
import type {
  AdminPrincipal,
  AdminPrincipalRequest,
  AdminPrincipalResolver,
} from '../admin-principal.js';

interface PrincipalRow extends QueryResultRow {
  user_id: string;
  tenant_id: string | null;
  permission_code: string | null;
}

export class PostgresAdminPrincipalResolver implements AdminPrincipalResolver {
  public constructor(
    private readonly database: PostgresDatabase,
    private readonly gatewayToken?: string,
  ) {}

  public async resolve(request: AdminPrincipalRequest): Promise<AdminPrincipal> {
    if (this.gatewayToken === undefined) {
      throw new AppError({
        code: 'MANAGEMENT_API_NOT_CONFIGURED',
        message: '管理 API 尚未配置安全令牌',
        statusCode: 503,
      });
    }

    const suppliedToken = this.bearerToken(request.authorization);
    if (suppliedToken === undefined || !this.tokensEqual(suppliedToken, this.gatewayToken)) {
      throw new AppError({
        code: 'ADMIN_UNAUTHORIZED',
        message: '管理端身份验证失败',
        statusCode: 401,
      });
    }

    if (request.adminUserId === undefined) {
      throw new AppError({
        code: 'ADMIN_UNAUTHORIZED',
        message: '缺少管理员身份',
        statusCode: 401,
      });
    }

    const result = await this.database.query<PrincipalRow>(
      `SELECT
         admin.id AS user_id,
         admin.tenant_id,
         permission.code AS permission_code
       FROM admin_users admin
       LEFT JOIN admin_user_roles assignment ON assignment.admin_user_id = admin.id
       LEFT JOIN roles role ON role.id = assignment.role_id
         AND (
           (admin.tenant_id IS NULL AND role.scope = 'PLATFORM' AND role.tenant_id IS NULL)
           OR
           (admin.tenant_id IS NOT NULL AND role.scope = 'TENANT' AND role.tenant_id = admin.tenant_id)
         )
       LEFT JOIN role_permissions role_permission ON role_permission.role_id = role.id
       LEFT JOIN permissions permission ON permission.code = role_permission.permission_code
       WHERE admin.id = $1 AND admin.status = 'ACTIVE'`,
      [request.adminUserId],
    );

    const first = result.rows[0];
    if (first === undefined) {
      throw new AppError({
        code: 'ADMIN_UNAUTHORIZED',
        message: '管理员不存在或已停用',
        statusCode: 401,
      });
    }

    return {
      userId: first.user_id,
      tenantId: first.tenant_id,
      permissions: new Set(
        result.rows.flatMap((row) =>
          row.permission_code === null ? [] : [row.permission_code],
        ),
      ),
    };
  }

  private bearerToken(authorization?: string): string | undefined {
    if (authorization === undefined) {
      return undefined;
    }

    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    return match?.[1];
  }

  private tokensEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
  }
}

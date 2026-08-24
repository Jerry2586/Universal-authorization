import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors/app-error.js';
import type {
  AdminPrincipal,
  AdminPrincipalResolver,
  ManagementRequestContext,
} from '../../modules/identity/admin-principal.js';
import {
  hasAllPermissions,
  hasTenantPermissions,
  type PermissionCode,
} from '../../modules/identity/domain/permissions.js';

const uuidSchema = z.string().uuid();

export async function requireManagementContext(
  request: FastifyRequest,
  resolver: AdminPrincipalResolver,
  required: readonly PermissionCode[],
): Promise<ManagementRequestContext> {
  const authorization = header(request, 'authorization');
  const adminUserId = header(request, 'x-admin-user-id');
  const principal = await resolver.resolve({
    ...(authorization === undefined ? {} : { authorization }),
    ...(adminUserId === undefined ? {} : { adminUserId }),
  });
  const tenantId = resolveTenantId(principal, header(request, 'x-tenant-id'));

  if (!hasTenantPermissions(principal, tenantId, required)) {
    throw new AppError({
      code: 'ADMIN_FORBIDDEN',
      message: '没有执行此操作的权限',
      statusCode: 403,
    });
  }

  return {
    principal,
    tenantId,
    requestId: request.id,
    sourceIp: request.ip,
    ...(request.headers['user-agent'] === undefined
      ? {}
      : { userAgent: request.headers['user-agent'] }),
  };
}

export async function requireBatchExportContext(
  request: FastifyRequest,
  resolver: AdminPrincipalResolver,
  required: readonly PermissionCode[],
): Promise<ManagementRequestContext> {
  const context = await requireManagementContext(request, resolver, required);
  if (!hasAllPermissions(context.principal.permissions, required)) {
    throw new AppError({
      code: 'ADMIN_FORBIDDEN',
      message: '没有批量交付授权的权限',
      statusCode: 403,
    });
  }
  return context;
}

function resolveTenantId(principal: AdminPrincipal, requested?: string): string {
  if (principal.tenantId !== null) {
    if (requested !== undefined && requested !== principal.tenantId) {
      throw new AppError({
        code: 'TENANT_ACCESS_DENIED',
        message: '不能访问其他租户的数据',
        statusCode: 403,
      });
    }
    return principal.tenantId;
  }

  if (requested === undefined) {
    throw new AppError({
      code: 'TENANT_REQUIRED',
      message: '平台管理员必须通过 X-Tenant-Id 指定目标租户',
      statusCode: 400,
    });
  }

  return uuidSchema.parse(requested);
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}


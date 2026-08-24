import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors/app-error.js';
import type {
  AdminPrincipal,
  AdminPrincipalResolver,
  AuthenticatedAdminRequestContext,
  ManagementRequestContext,
} from '../../modules/identity/admin-principal.js';
import { hasAllPermissions, hasTenantPermissions, type PermissionCode } from '../../modules/identity/domain/permissions.js';
import { ADMIN_SESSION_COOKIE, parseCookie } from '../../modules/admin-auth/admin-cookie.js';

const uuidSchema = z.string().uuid();
const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function requireManagementContext(
  request: FastifyRequest,
  resolver: AdminPrincipalResolver,
  required: readonly PermissionCode[],
): Promise<ManagementRequestContext> {
  const authenticated = await requireAuthenticatedAdminContext(request, resolver);
  const tenantId = resolveTenantId(authenticated.principal, header(request, 'x-tenant-id'));

  if (!hasTenantPermissions(authenticated.principal, tenantId, required)) {
    throw new AppError({ code: 'ADMIN_FORBIDDEN', message: '没有执行此操作的权限', statusCode: 403 });
  }

  return { ...authenticated, tenantId };
}

export async function requireAuthenticatedAdminContext(
  request: FastifyRequest,
  resolver: AdminPrincipalResolver,
): Promise<AuthenticatedAdminRequestContext> {
  const authorization = header(request, 'authorization');
  const adminUserId = header(request, 'x-admin-user-id');
  const sessionToken = parseCookie(header(request, 'cookie'), ADMIN_SESSION_COOKIE);
  const csrfRequired = sessionToken !== undefined && !safeMethods.has(request.method.toUpperCase());
  if (csrfRequired) ensureSameOrigin(request);
  const csrfToken = header(request, 'x-csrf-token');
  const principal = await resolver.resolve({
    ...(authorization === undefined ? {} : { authorization }),
    ...(adminUserId === undefined ? {} : { adminUserId }),
    ...(sessionToken === undefined ? {} : { sessionToken }),
    ...(csrfToken === undefined ? {} : { csrfToken }),
    ...(csrfRequired ? { csrfRequired: true } : {}),
  });
  return {
    principal,
    tenantId: principal.tenantId,
    requestId: request.id,
    sourceIp: request.ip,
    ...(request.headers['user-agent'] === undefined ? {} : { userAgent: request.headers['user-agent'] }),
  };
}

export async function requireAnyManagementContext(
  request: FastifyRequest,
  resolver: AdminPrincipalResolver,
  requiredAny: readonly PermissionCode[],
): Promise<ManagementRequestContext> {
  const context = await requireManagementContext(request, resolver, []);
  const allowed = requiredAny.some((permission) =>
    hasTenantPermissions(context.principal, context.tenantId, [permission]),
  );
  if (!allowed) {
    throw new AppError({ code: 'ADMIN_FORBIDDEN', message: '没有执行此操作的权限', statusCode: 403 });
  }
  return context;
}

export async function requireBatchExportContext(
  request: FastifyRequest,
  resolver: AdminPrincipalResolver,
  required: readonly PermissionCode[],
): Promise<ManagementRequestContext> {
  const context = await requireManagementContext(request, resolver, required);
  if (!hasAllPermissions(context.principal.permissions, required)) {
    throw new AppError({ code: 'ADMIN_FORBIDDEN', message: '没有批量交付授权的权限', statusCode: 403 });
  }
  return context;
}

function resolveTenantId(principal: AdminPrincipal, requested?: string): string {
  if (principal.tenantId !== null) {
    if (requested !== undefined && requested !== principal.tenantId) {
      throw new AppError({ code: 'TENANT_ACCESS_DENIED', message: '不能访问其他租户的数据', statusCode: 403 });
    }
    return principal.tenantId;
  }
  if (requested === undefined) {
    throw new AppError({ code: 'TENANT_REQUIRED', message: '平台管理员必须通过 X-Tenant-Id 指定目标租户', statusCode: 400 });
  }
  return uuidSchema.parse(requested);
}

function ensureSameOrigin(request: FastifyRequest): void {
  const origin = header(request, 'origin');
  const host = header(request, 'host');
  if (origin === undefined || host === undefined) return;
  try {
    if (new URL(origin).host !== host) throw new Error('origin mismatch');
  } catch {
    throw new AppError({ code: 'ADMIN_ORIGIN_INVALID', message: '请求来源不可信', statusCode: 403 });
  }
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

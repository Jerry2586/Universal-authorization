import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { successResponse } from '../../shared/http/api-response.js';
import { AppError } from '../../shared/errors/app-error.js';
import { ADMIN_SESSION_COOKIE, clearSessionCookie, parseCookie, sessionCookie } from './admin-cookie.js';
import type { AdminAuthService } from './admin-auth.service.js';

export interface AdminAuthRouteDependencies {
  service: AdminAuthService;
  secureCookie: boolean;
  sessionTtlSeconds: number;
}

const loginSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(8).max(256),
  tenant_code: z.string().trim().min(2).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
});

export function registerAdminAuthRoutes(app: FastifyInstance, dependencies: AdminAuthRouteDependencies): void {
  app.post('/admin/auth/login', async (request, reply) => {
    ensureSameOrigin(request);
    const body = loginSchema.parse(request.body);
    const result = await dependencies.service.login({
      email: body.email,
      password: body.password,
      ...(body.tenant_code === undefined ? {} : { tenantCode: body.tenant_code }),
      requestId: request.id,
      sourceIp: request.ip,
      ...(request.headers['user-agent'] === undefined ? {} : { userAgent: request.headers['user-agent'] }),
    });
    reply.header('set-cookie', sessionCookie(result.session.sessionToken, { secure: dependencies.secureCookie, maxAge: dependencies.sessionTtlSeconds }));
    reply.header('cache-control', 'no-store');
    return successResponse(request.id, authResponse(result.admin, result.session.csrfToken, result.session.expiresAt), '登录成功');
  });

  app.get('/admin/auth/me', async (request, reply) => {
    const token = sessionToken(request);
    const result = await dependencies.service.current(token);
    reply.header('cache-control', 'no-store');
    return successResponse(request.id, authResponse(result.admin, result.session.csrfToken, result.session.expiresAt), '管理员会话有效');
  });

  app.get('/admin/auth/csrf', async (request, reply) => {
    const result = await dependencies.service.current(sessionToken(request));
    reply.header('cache-control', 'no-store');
    return successResponse(request.id, { csrf_token: result.session.csrfToken, expires_at: result.session.expiresAt }, '安全令牌读取成功');
  });

  app.post('/admin/auth/logout', async (request, reply) => {
    ensureSameOrigin(request);
    const token = sessionToken(request);
    const csrfToken = header(request, 'x-csrf-token');
    if (csrfToken === undefined) throw new AppError({ code: 'ADMIN_CSRF_INVALID', message: '缺少安全令牌，请刷新页面后重试', statusCode: 403 });
    await dependencies.service.logout(token, {
      requestId: request.id,
      sourceIp: request.ip,
      csrfToken,
      ...(request.headers['user-agent'] === undefined ? {} : { userAgent: request.headers['user-agent'] }),
    });
    reply.header('set-cookie', clearSessionCookie(dependencies.secureCookie));
    reply.header('cache-control', 'no-store');
    return successResponse(request.id, { logged_out: true }, '退出登录成功');
  });
}

function sessionToken(request: FastifyRequest): string {
  const token = parseCookie(header(request, 'cookie'), ADMIN_SESSION_COOKIE);
  if (token === undefined) throw new AppError({ code: 'ADMIN_SESSION_INVALID', message: '请先登录管理后台', statusCode: 401 });
  return token;
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

function authResponse(admin: { id: string; tenantId: string | null; tenantCode: string | null; tenantName: string | null; email: string; displayName: string; permissions: string[]; status: string; lastLoginAt: Date | null; createdAt: Date; roles: Array<{ id: string; code: string; name: string }> }, csrfToken: string, expiresAt: string) {
  return {
    admin: {
      id: admin.id,
      email: admin.email,
      display_name: admin.displayName,
      tenant: admin.tenantId === null ? null : { id: admin.tenantId, code: admin.tenantCode, name: admin.tenantName },
      permissions: admin.permissions,
      status: admin.status,
      last_login_at: admin.lastLoginAt?.toISOString() ?? null,
      created_at: admin.createdAt.toISOString(),
      roles: admin.roles,
    },
    csrf_token: csrfToken,
    expires_at: expiresAt,
  };
}

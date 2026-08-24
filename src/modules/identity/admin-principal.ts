import type { PermissionCode } from './domain/permissions.js';

export interface AdminPrincipal {
  userId: string;
  tenantId: string | null;
  permissions: ReadonlySet<string>;
}

export interface AdminPrincipalRequest {
  authorization?: string;
  adminUserId?: string;
  sessionToken?: string;
  csrfToken?: string;
  csrfRequired?: boolean;
}

export interface AdminPrincipalResolver {
  resolve(request: AdminPrincipalRequest): Promise<AdminPrincipal>;
}

export interface ManagementRequestContext {
  principal: AdminPrincipal;
  tenantId: string;
  requestId: string;
  sourceIp?: string;
  userAgent?: string;
}

export interface AuthenticatedAdminRequestContext {
  principal: AdminPrincipal;
  tenantId: string | null;
  requestId: string;
  sourceIp?: string;
  userAgent?: string;
}

export interface RequiredManagementPermission {
  permissions: readonly PermissionCode[];
  platformOnly?: boolean;
}

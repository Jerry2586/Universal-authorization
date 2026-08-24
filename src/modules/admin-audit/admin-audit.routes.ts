import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { successResponse } from '../../shared/http/api-response.js';
import { requireManagementContext } from '../../shared/management/management-context.js';
import type { AdminPrincipalResolver } from '../identity/admin-principal.js';
import { PERMISSIONS } from '../identity/domain/permissions.js';
import type { AdminAuditQueryService } from './admin-audit-query.service.js';
import type { AdminAuditLogRecord, AdminLicenseEventRecord } from './admin-audit-query.repository.js';

export interface AdminAuditRouteDependencies {
  principalResolver: AdminPrincipalResolver;
  auditQueryService: AdminAuditQueryService;
}

const uuid = z.string().uuid();
const paging = {
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  occurred_from: z.iso.datetime({ offset: true }).transform((value) => new Date(value)).optional(),
  occurred_to: z.iso.datetime({ offset: true }).transform((value) => new Date(value)).optional(),
};
const auditQuerySchema = z.object({
  ...paging,
  actor_type: z.enum(['ADMIN_USER', 'SYSTEM', 'API_CLIENT']).optional(),
  actor_id: uuid.optional(),
  action: z.string().trim().min(1).max(128).optional(),
  resource_type: z.string().trim().min(1).max(96).optional(),
  resource_id: z.string().trim().min(1).max(128).optional(),
  result: z.enum(['SUCCESS', 'FAILURE']).optional(),
  request_id: z.string().trim().min(1).max(128).optional(),
}).refine(validTimeRange, { message: 'occurred_from 不能晚于 occurred_to' });
const licenseEventQuerySchema = z.object({
  ...paging,
  product_id: uuid.optional(),
  license_id: uuid.optional(),
  device_id: uuid.optional(),
  activation_id: uuid.optional(),
  session_id: uuid.optional(),
  event_type: z.string().trim().min(1).max(96).optional(),
  result: z.enum(['SUCCESS', 'FAILURE']).optional(),
  reason_code: z.string().trim().min(1).max(96).optional(),
  request_id: z.string().trim().min(1).max(128).optional(),
}).refine(validTimeRange, { message: 'occurred_from 不能晚于 occurred_to' });

export function registerAdminAuditRoutes(app: FastifyInstance, dependencies: AdminAuditRouteDependencies): void {
  app.get('/admin/v1/audit-logs', async (request) => {
    const context = await requireManagementContext(request, dependencies.principalResolver, [PERMISSIONS.AUDIT_READ]);
    const query = auditQuerySchema.parse(request.query);
    const page = await dependencies.auditQueryService.listAuditLogs(context, {
      limit: query.limit,
      offset: query.offset,
      ...(query.actor_type === undefined ? {} : { actorType: query.actor_type }),
      ...(query.actor_id === undefined ? {} : { actorId: query.actor_id }),
      ...(query.action === undefined ? {} : { action: query.action }),
      ...(query.resource_type === undefined ? {} : { resourceType: query.resource_type }),
      ...(query.resource_id === undefined ? {} : { resourceId: query.resource_id }),
      ...(query.result === undefined ? {} : { result: query.result }),
      ...(query.request_id === undefined ? {} : { requestId: query.request_id }),
      ...(query.occurred_from === undefined ? {} : { occurredFrom: query.occurred_from }),
      ...(query.occurred_to === undefined ? {} : { occurredTo: query.occurred_to }),
    });
    return successResponse(request.id, {
      items: page.items.map(auditLogResponse),
      total: page.total,
      limit: query.limit,
      offset: query.offset,
    }, '管理员审计日志读取成功');
  });

  app.get('/admin/v1/license-events', async (request) => {
    const context = await requireManagementContext(request, dependencies.principalResolver, [PERMISSIONS.AUDIT_READ]);
    const query = licenseEventQuerySchema.parse(request.query);
    const page = await dependencies.auditQueryService.listLicenseEvents(context, {
      limit: query.limit,
      offset: query.offset,
      ...(query.product_id === undefined ? {} : { productId: query.product_id }),
      ...(query.license_id === undefined ? {} : { licenseId: query.license_id }),
      ...(query.device_id === undefined ? {} : { deviceId: query.device_id }),
      ...(query.activation_id === undefined ? {} : { activationId: query.activation_id }),
      ...(query.session_id === undefined ? {} : { sessionId: query.session_id }),
      ...(query.event_type === undefined ? {} : { eventType: query.event_type }),
      ...(query.result === undefined ? {} : { result: query.result }),
      ...(query.reason_code === undefined ? {} : { reasonCode: query.reason_code }),
      ...(query.request_id === undefined ? {} : { requestId: query.request_id }),
      ...(query.occurred_from === undefined ? {} : { occurredFrom: query.occurred_from }),
      ...(query.occurred_to === undefined ? {} : { occurredTo: query.occurred_to }),
    });
    return successResponse(request.id, {
      items: page.items.map(licenseEventResponse),
      total: page.total,
      limit: query.limit,
      offset: query.offset,
    }, '授权事件读取成功');
  });
}

function validTimeRange(value: { occurred_from?: Date | undefined; occurred_to?: Date | undefined }): boolean {
  return value.occurred_from === undefined
    || value.occurred_to === undefined
    || value.occurred_from.getTime() <= value.occurred_to.getTime();
}

function auditLogResponse(item: AdminAuditLogRecord) {
  return {
    id: item.id,
    tenant_id: item.tenantId,
    actor_type: item.actorType,
    actor_id: item.actorId,
    action: item.action,
    resource_type: item.resourceType,
    resource_id: item.resourceId,
    request_id: item.requestId,
    source_ip: item.sourceIp,
    user_agent: item.userAgent,
    result: item.result,
    before_data: item.beforeData,
    after_data: item.afterData,
    metadata: item.metadata,
    occurred_at: item.occurredAt.toISOString(),
  };
}

function licenseEventResponse(item: AdminLicenseEventRecord) {
  return {
    id: item.id,
    tenant_id: item.tenantId,
    product_id: item.productId,
    license_id: item.licenseId,
    device_id: item.deviceId,
    activation_id: item.activationId,
    session_id: item.sessionId,
    event_type: item.eventType,
    result: item.result,
    reason_code: item.reasonCode,
    request_id: item.requestId,
    ip_address: item.ipAddress,
    metadata: item.metadata,
    occurred_at: item.occurredAt.toISOString(),
  };
}


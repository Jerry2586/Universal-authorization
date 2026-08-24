import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { successResponse } from '../../shared/http/api-response.js';
import { requireManagementContext } from '../../shared/management/management-context.js';
import type { AdminPrincipalResolver } from '../identity/admin-principal.js';
import { PERMISSIONS } from '../identity/domain/permissions.js';
import type { ManagedDeviceBinding } from './admin-device.repository.js';
import type { AdminDeviceManagementService } from './admin-device-management.service.js';

export interface AdminDeviceRouteDependencies {
  principalResolver: AdminPrincipalResolver;
  deviceService: AdminDeviceManagementService;
}

const uuid = z.string().uuid();
const licenseParams = z.object({ licenseId: uuid });
const deviceParams = z.object({ deviceId: uuid });
const listQuery = z.object({
  activation_status: z.enum(['ACTIVE', 'UNBOUND', 'BLOCKED', 'REPLACED']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const actionSchema = z.object({ reason: z.string().trim().min(1).max(255) });
const unbindSchema = actionSchema.extend({ license_id: uuid });

export function registerAdminDeviceRoutes(app: FastifyInstance, dependencies: AdminDeviceRouteDependencies): void {
  app.get('/admin/v1/license-keys/:licenseId/devices', async (request) => {
    const context = await requireManagementContext(request, dependencies.principalResolver, [PERMISSIONS.DEVICES_READ]);
    const params = licenseParams.parse(request.params);
    const query = listQuery.parse(request.query);
    const devices = await dependencies.deviceService.listLicenseDevices(context, params.licenseId, {
      limit: query.limit,
      offset: query.offset,
      ...(query.activation_status === undefined ? {} : { activationStatus: query.activation_status }),
    });
    return successResponse(request.id, {
      items: devices.map(deviceResponse),
      limit: query.limit,
      offset: query.offset,
    }, '设备绑定列表读取成功');
  });

  app.post('/admin/v1/devices/:deviceId/unbind', async (request) => {
    const context = await requireManagementContext(request, dependencies.principalResolver, [PERMISSIONS.DEVICES_UNBIND]);
    const params = deviceParams.parse(request.params);
    const body = unbindSchema.parse(request.body);
    const result = await dependencies.deviceService.forceUnbind(context, params.deviceId, body.license_id, { reason: body.reason });
    return successResponse(request.id, result, result.changed ? '管理员强制解绑成功' : '设备绑定已经是解绑状态');
  });

  app.post('/admin/v1/devices/:deviceId/block', async (request) => {
    const context = await requireManagementContext(request, dependencies.principalResolver, [PERMISSIONS.DEVICES_BLOCK]);
    const params = deviceParams.parse(request.params);
    const body = actionSchema.parse(request.body);
    const result = await dependencies.deviceService.block(context, params.deviceId, { reason: body.reason });
    return successResponse(request.id, result, result.changed ? '设备封禁成功' : '设备已经处于封禁状态');
  });

  app.post('/admin/v1/devices/:deviceId/unblock', async (request) => {
    const context = await requireManagementContext(request, dependencies.principalResolver, [PERMISSIONS.DEVICES_BLOCK]);
    const params = deviceParams.parse(request.params);
    const body = actionSchema.parse(request.body);
    const result = await dependencies.deviceService.unblock(context, params.deviceId, { reason: body.reason });
    return successResponse(request.id, result, result.changed ? '设备解封成功' : '设备当前没有有效封禁');
  });
}

function deviceResponse(item: ManagedDeviceBinding) {
  return {
    device_id: item.deviceId,
    tenant_id: item.tenantId,
    license_id: item.licenseId,
    activation_id: item.activationId,
    device_status: item.deviceStatus,
    activation_status: item.activationStatus,
    platform: item.platform,
    os_version: item.osVersion,
    display_name: item.displayName,
    device_public_key_fingerprint: item.devicePublicKeyFingerprint,
    fingerprint_hash: item.fingerprintHash,
    risk_score: item.riskScore,
    first_seen_at: item.firstSeenAt.toISOString(),
    last_seen_at: item.lastSeenAt?.toISOString() ?? null,
    activated_at: item.activatedAt.toISOString(),
    last_verified_at: item.lastVerifiedAt?.toISOString() ?? null,
    unbound_at: item.unboundAt?.toISOString() ?? null,
    active_session_count: item.activeSessionCount,
    blocked: item.blocked,
    block_reason: item.blockReason,
    blocked_at: item.blockedAt?.toISOString() ?? null,
  };
}

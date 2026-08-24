import type { Clock } from '../challenges/challenge.service.js';
import type { AuditLogPort } from '../audit/audit-log.port.js';
import type { ManagementRequestContext } from '../identity/admin-principal.js';
import type { OnlineSessionStore } from '../sessions/online-session.store.js';
import type { PageResult } from '../../shared/pagination/page-result.js';
import type {
  ActivationStatus,
  AdminDeviceRepository,
  DeviceBindingListInput,
  ManagedDeviceBinding,
} from './admin-device.repository.js';

export interface ListLicenseDevicesInput {
  activationStatus?: ActivationStatus;
  limit: number;
  offset: number;
}

export interface AdminDeviceActionRequest {
  reason: string;
}

export interface AdminForceUnbindResponse {
  unbound: true;
  changed: boolean;
  license_id: string;
  device_id: string;
  activation_id: string;
  activation_status: 'UNBOUND';
  revoked_session_count: number;
  unbound_at: string;
}

export interface AdminBlockDeviceResponse {
  blocked: true;
  changed: boolean;
  device_id: string;
  device_status: 'BLOCKED';
  block_id: string;
  blocked_activation_count: number;
  revoked_session_count: number;
  blocked_at: string;
}

export interface AdminUnblockDeviceResponse {
  unblocked: true;
  changed: boolean;
  device_id: string;
  device_status: 'ACTIVE' | 'DISABLED';
  released_block_count: number;
  released_at: string;
  old_bindings_restored: false;
  old_sessions_restored: false;
}

export class AdminDeviceManagementService {
  public constructor(
    private readonly repository: AdminDeviceRepository,
    private readonly auditLog: AuditLogPort,
    private readonly onlineStore: OnlineSessionStore,
    private readonly clock: Clock = () => new Date(),
  ) {}

  public async listLicenseDevices(
    context: ManagementRequestContext,
    licenseId: string,
    input: ListLicenseDevicesInput,
  ): Promise<PageResult<ManagedDeviceBinding>> {
    const repositoryInput: DeviceBindingListInput = {
      tenantId: context.tenantId,
      licenseId,
      limit: input.limit,
      offset: input.offset,
      ...(input.activationStatus === undefined ? {} : { activationStatus: input.activationStatus }),
    };
    return this.repository.listLicenseDevices(repositoryInput);
  }

  public async forceUnbind(
    context: ManagementRequestContext,
    deviceId: string,
    licenseId: string,
    request: AdminDeviceActionRequest,
  ): Promise<AdminForceUnbindResponse> {
    const now = this.clock();
    const result = await this.repository.forceUnbind({
      tenantId: context.tenantId,
      deviceId,
      licenseId,
      adminUserId: context.principal.userId,
      reason: request.reason,
      now,
      requestId: context.requestId,
      ipAddress: context.sourceIp ?? null,
    });
    await this.onlineStore.removeMany(result.revokedSessionIds);
    await this.audit(context, 'device.force-unbind', deviceId, result.before, result.after, {
      license_id: licenseId,
      activation_id: result.activationId,
      reason: request.reason,
      changed: result.changed,
      revoked_session_count: result.revokedSessionIds.length,
    }, now);
    return {
      unbound: true,
      changed: result.changed,
      license_id: result.licenseId,
      device_id: result.deviceId,
      activation_id: result.activationId,
      activation_status: result.activationStatus,
      revoked_session_count: result.revokedSessionIds.length,
      unbound_at: result.unboundAt.toISOString(),
    };
  }

  public async block(
    context: ManagementRequestContext,
    deviceId: string,
    request: AdminDeviceActionRequest,
  ): Promise<AdminBlockDeviceResponse> {
    const now = this.clock();
    const result = await this.repository.block({
      tenantId: context.tenantId,
      deviceId,
      adminUserId: context.principal.userId,
      reason: request.reason,
      now,
      requestId: context.requestId,
      ipAddress: context.sourceIp ?? null,
    });
    await this.onlineStore.removeMany(result.revokedSessionIds);
    await this.audit(context, 'device.block', deviceId, result.before, result.after, {
      block_id: result.blockId,
      reason: request.reason,
      changed: result.changed,
      blocked_activation_count: result.blockedActivationCount,
      revoked_session_count: result.revokedSessionIds.length,
    }, now);
    return {
      blocked: true,
      changed: result.changed,
      device_id: result.deviceId,
      device_status: result.deviceStatus,
      block_id: result.blockId,
      blocked_activation_count: result.blockedActivationCount,
      revoked_session_count: result.revokedSessionIds.length,
      blocked_at: result.blockedAt.toISOString(),
    };
  }

  public async unblock(
    context: ManagementRequestContext,
    deviceId: string,
    request: AdminDeviceActionRequest,
  ): Promise<AdminUnblockDeviceResponse> {
    const now = this.clock();
    const result = await this.repository.unblock({
      tenantId: context.tenantId,
      deviceId,
      adminUserId: context.principal.userId,
      reason: request.reason,
      now,
      requestId: context.requestId,
      ipAddress: context.sourceIp ?? null,
    });
    await this.audit(context, 'device.unblock', deviceId, result.before, result.after, {
      reason: request.reason,
      changed: result.changed,
      released_block_count: result.releasedBlockCount,
      old_bindings_restored: false,
      old_sessions_restored: false,
    }, now);
    return {
      unblocked: true,
      changed: result.changed,
      device_id: result.deviceId,
      device_status: result.deviceStatus === 'BLOCKED' ? 'ACTIVE' : result.deviceStatus,
      released_block_count: result.releasedBlockCount,
      released_at: result.releasedAt.toISOString(),
      old_bindings_restored: false,
      old_sessions_restored: false,
    };
  }

  private async audit(
    context: ManagementRequestContext,
    action: string,
    deviceId: string,
    before: Readonly<Record<string, unknown>> | object,
    after: Readonly<Record<string, unknown>> | object,
    metadata: Readonly<Record<string, unknown>>,
    occurredAt: Date,
  ): Promise<void> {
    await this.auditLog.append({
      actor: { type: 'ADMIN_USER', id: context.principal.userId, tenantId: context.tenantId },
      action,
      resourceType: 'DEVICE',
      resourceId: deviceId,
      requestId: context.requestId,
      ...(context.sourceIp === undefined ? {} : { sourceIp: context.sourceIp }),
      ...(context.userAgent === undefined ? {} : { userAgent: context.userAgent }),
      result: 'SUCCESS',
      before: before as Readonly<Record<string, unknown>>,
      after: after as Readonly<Record<string, unknown>>,
      metadata,
      occurredAt,
    });
  }
}

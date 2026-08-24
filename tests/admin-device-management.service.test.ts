import { describe, expect, it } from 'vitest';
import type { AuditEvent, AuditLogPort } from '../src/modules/audit/audit-log.port.js';
import type { ManagementRequestContext } from '../src/modules/identity/admin-principal.js';
import { InMemoryOnlineSessionStore } from '../src/modules/sessions/infrastructure/in-memory-online-session.store.js';
import { AdminDeviceManagementService } from '../src/modules/admin-devices/admin-device-management.service.js';
import type {
  AdminDeviceActionInput,
  AdminDeviceRepository,
  BlockDeviceResult,
  DeviceBindingListInput,
  ForceUnbindDeviceInput,
  ForceUnbindDeviceResult,
  ManagedDeviceBinding,
  UnblockDeviceResult,
} from '../src/modules/admin-devices/admin-device.repository.js';

const now = new Date('2026-08-24T14:00:00.000Z');
const tenantId = '11111111-1111-4111-8111-111111111111';
const adminId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const deviceId = '22222222-2222-4222-8222-222222222222';
const licenseId = '33333333-3333-4333-8333-333333333333';
const activationId = '44444444-4444-4444-8444-444444444444';

class AuditCollector implements AuditLogPort {
  public readonly events: AuditEvent[] = [];
  public async append(event: AuditEvent): Promise<void> { this.events.push(event); }
}

class FakeRepository implements AdminDeviceRepository {
  public listInput?: DeviceBindingListInput;
  public forceInput?: ForceUnbindDeviceInput;
  public blockInput?: AdminDeviceActionInput;
  public unblockInput?: AdminDeviceActionInput;

  public async listLicenseDevices(input: DeviceBindingListInput): Promise<readonly ManagedDeviceBinding[]> {
    this.listInput = input;
    return [binding];
  }
  public async forceUnbind(input: ForceUnbindDeviceInput): Promise<ForceUnbindDeviceResult> {
    this.forceInput = input;
    return {
      deviceId, licenseId, activationId, previousActivationStatus: 'ACTIVE', activationStatus: 'UNBOUND',
      unboundAt: now, revokedSessionIds: ['session-1', 'session-2'], changed: true,
      before: snapshot('ACTIVE', 'ACTIVE'), after: snapshot('ACTIVE', 'UNBOUND'),
    };
  }
  public async block(input: AdminDeviceActionInput): Promise<BlockDeviceResult> {
    this.blockInput = input;
    return {
      deviceId, deviceStatus: 'BLOCKED', blockId: '55555555-5555-4555-8555-555555555555',
      blockedAt: now, blockedActivationCount: 1, revokedSessionIds: ['session-1'], changed: true,
      before: snapshot('ACTIVE', 'ACTIVE'), after: snapshot('BLOCKED', 'BLOCKED'),
    };
  }
  public async unblock(input: AdminDeviceActionInput): Promise<UnblockDeviceResult> {
    this.unblockInput = input;
    return {
      deviceId, deviceStatus: 'ACTIVE', releasedBlockCount: 1, releasedAt: now, changed: true,
      before: snapshot('BLOCKED', 'BLOCKED'), after: snapshot('ACTIVE', 'BLOCKED'),
    };
  }
}

describe('AdminDeviceManagementService', () => {
  it('lists only the current tenant license devices', async () => {
    const repository = new FakeRepository();
    const service = new AdminDeviceManagementService(repository, new AuditCollector(), new InMemoryOnlineSessionStore(), () => now);
    const result = await service.listLicenseDevices(context(), licenseId, { activationStatus: 'ACTIVE', limit: 20, offset: 0 });
    expect(result).toHaveLength(1);
    expect(repository.listInput).toEqual({ tenantId, licenseId, activationStatus: 'ACTIVE', limit: 20, offset: 0 });
  });

  it('force-unbinds, clears every revoked online session and writes an admin audit', async () => {
    const repository = new FakeRepository();
    const audit = new AuditCollector();
    const online = new InMemoryOnlineSessionStore(() => now);
    await online.markOnline(onlineState('session-1'), 180);
    await online.markOnline(onlineState('session-2'), 180);
    const service = new AdminDeviceManagementService(repository, audit, online, () => now);
    const result = await service.forceUnbind(context(), deviceId, licenseId, { reason: '用户申请换机' });
    expect(result).toMatchObject({ unbound: true, activation_status: 'UNBOUND', revoked_session_count: 2 });
    expect(online.get('session-1')).toBeUndefined();
    expect(online.get('session-2')).toBeUndefined();
    expect(repository.forceInput).toMatchObject({ tenantId, deviceId, licenseId, adminUserId: adminId, reason: '用户申请换机' });
    expect(audit.events[0]).toMatchObject({ action: 'device.force-unbind', resourceType: 'DEVICE', resourceId: deviceId, result: 'SUCCESS' });
  });

  it('blocks a device, clears revoked sessions and audits the affected bindings', async () => {
    const repository = new FakeRepository();
    const audit = new AuditCollector();
    const online = new InMemoryOnlineSessionStore(() => now);
    await online.markOnline(onlineState('session-1'), 180);
    const service = new AdminDeviceManagementService(repository, audit, online, () => now);
    const result = await service.block(context(), deviceId, { reason: '设备被盗' });
    expect(result).toMatchObject({ blocked: true, device_status: 'BLOCKED', blocked_activation_count: 1, revoked_session_count: 1 });
    expect(online.get('session-1')).toBeUndefined();
    expect(audit.events[0]?.metadata).toMatchObject({ reason: '设备被盗', blocked_activation_count: 1 });
  });

  it('unblocks only the device block and never restores old bindings or sessions', async () => {
    const repository = new FakeRepository();
    const audit = new AuditCollector();
    const service = new AdminDeviceManagementService(repository, audit, new InMemoryOnlineSessionStore(), () => now);
    const result = await service.unblock(context(), deviceId, { reason: '人工核验通过' });
    expect(result).toMatchObject({
      unblocked: true, device_status: 'ACTIVE', old_bindings_restored: false, old_sessions_restored: false,
    });
    expect(audit.events[0]?.metadata).toMatchObject({ old_bindings_restored: false, old_sessions_restored: false });
  });
});

const binding: ManagedDeviceBinding = {
  deviceId, tenantId, licenseId, activationId, deviceStatus: 'ACTIVE', activationStatus: 'ACTIVE',
  platform: 'windows', osVersion: '11', displayName: '办公室电脑', devicePublicKeyFingerprint: 'device-key-fingerprint',
  fingerprintHash: 'hardware-fingerprint', riskScore: 0, firstSeenAt: now, lastSeenAt: now,
  activatedAt: now, lastVerifiedAt: now, unboundAt: null, activeSessionCount: 1,
  blocked: false, blockReason: null, blockedAt: null,
};
function context(): ManagementRequestContext {
  return { principal: { userId: adminId, tenantId, permissions: new Set() }, tenantId, requestId: 'request-7', sourceIp: '127.0.0.1' };
}
function snapshot(deviceStatus: 'ACTIVE' | 'BLOCKED', activationStatus: 'ACTIVE' | 'UNBOUND' | 'BLOCKED') {
  return { deviceId, deviceStatus, activationStatuses: [{ activationId, licenseId, status: activationStatus }] };
}
function onlineState(sessionId: string) {
  return { sessionId, licenseId, deviceId, activationId, lastHeartbeatAt: now, sequence: 1 };
}

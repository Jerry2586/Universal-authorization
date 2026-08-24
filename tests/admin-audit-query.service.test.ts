import { describe, expect, it } from 'vitest';
import type { AuditEvent, AuditLogPort } from '../src/modules/audit/audit-log.port.js';
import type { ManagementRequestContext } from '../src/modules/identity/admin-principal.js';
import { AdminAuditQueryService } from '../src/modules/admin-audit/admin-audit-query.service.js';
import type {
  AdminAuditLogRecord,
  AdminAuditQueryRepository,
  AdminLicenseEventRecord,
  AuditLogQueryInput,
  LicenseEventQueryInput,
} from '../src/modules/admin-audit/admin-audit-query.repository.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const adminId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const now = new Date('2026-08-24T15:00:00.000Z');

class FakeRepository implements AdminAuditQueryRepository {
  public auditInput?: AuditLogQueryInput;
  public licenseInput?: LicenseEventQueryInput;

  public async listAuditLogs(input: AuditLogQueryInput): Promise<readonly AdminAuditLogRecord[]> {
    this.auditInput = input;
    return [auditRecord];
  }

  public async listLicenseEvents(input: LicenseEventQueryInput): Promise<readonly AdminLicenseEventRecord[]> {
    this.licenseInput = input;
    return [licenseEvent];
  }
}

class AuditCollector implements AuditLogPort {
  public readonly events: AuditEvent[] = [];
  public async append(event: AuditEvent): Promise<void> { this.events.push(event); }
}

describe('AdminAuditQueryService', () => {
  it('forces the current tenant into audit-log queries and records the sensitive read', async () => {
    const repository = new FakeRepository();
    const audit = new AuditCollector();
    const service = new AdminAuditQueryService(repository, audit, () => now);
    const occurredFrom = new Date('2026-08-01T00:00:00.000Z');

    const result = await service.listAuditLogs(context(), {
      action: 'device.block',
      result: 'SUCCESS',
      occurredFrom,
      limit: 20,
      offset: 0,
    });

    expect(result).toEqual([auditRecord]);
    expect(repository.auditInput).toEqual({
      tenantId,
      action: 'device.block',
      result: 'SUCCESS',
      occurredFrom,
      limit: 20,
      offset: 0,
    });
    expect(audit.events[0]).toMatchObject({
      actor: { type: 'ADMIN_USER', id: adminId, tenantId },
      action: 'audit-log.read',
      resourceType: 'AUDIT_LOG',
      resourceId: tenantId,
      result: 'SUCCESS',
      metadata: { item_count: 1 },
      occurredAt: now,
    });
  });

  it('queries authorization events by IDs without accepting or exposing plaintext Key values', async () => {
    const repository = new FakeRepository();
    const audit = new AuditCollector();
    const service = new AdminAuditQueryService(repository, audit, () => now);

    const result = await service.listLicenseEvents(context(), {
      licenseId: licenseEvent.licenseId!,
      deviceId: licenseEvent.deviceId!,
      eventType: 'ADMIN_DEVICE_BLOCKED',
      limit: 50,
      offset: 10,
    });

    expect(result).toEqual([licenseEvent]);
    expect(repository.licenseInput).toMatchObject({
      tenantId,
      licenseId: licenseEvent.licenseId,
      deviceId: licenseEvent.deviceId,
      eventType: 'ADMIN_DEVICE_BLOCKED',
      limit: 50,
      offset: 10,
    });
    expect(JSON.stringify(repository.licenseInput)).not.toContain('license_key');
    expect(audit.events[0]).toMatchObject({ action: 'license-event.read', resourceType: 'LICENSE_EVENT' });
  });
});

function context(): ManagementRequestContext {
  return {
    principal: { userId: adminId, tenantId, permissions: new Set(['audit.read']) },
    tenantId,
    requestId: 'request-audit-1',
    sourceIp: '127.0.0.1',
    userAgent: 'vitest',
  };
}

const auditRecord: AdminAuditLogRecord = {
  id: '101', tenantId, actorType: 'ADMIN_USER', actorId: adminId,
  action: 'device.block', resourceType: 'DEVICE', resourceId: '22222222-2222-4222-8222-222222222222',
  requestId: 'request-old', sourceIp: '127.0.0.1', userAgent: 'vitest', result: 'SUCCESS',
  beforeData: { status: 'ACTIVE' }, afterData: { status: 'BLOCKED' }, metadata: { reason: '风险设备' }, occurredAt: now,
};

const licenseEvent: AdminLicenseEventRecord = {
  id: '202', tenantId, productId: '33333333-3333-4333-8333-333333333333',
  licenseId: '44444444-4444-4444-8444-444444444444', deviceId: '55555555-5555-4555-8555-555555555555',
  activationId: '66666666-6666-4666-8666-666666666666', sessionId: null,
  eventType: 'ADMIN_DEVICE_BLOCKED', result: 'SUCCESS', reasonCode: 'ADMIN_BLOCKED',
  requestId: 'request-event', ipAddress: '127.0.0.1', metadata: { reason: '风险设备' }, occurredAt: now,
};


import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { AdminPrincipalResolver } from '../src/modules/identity/admin-principal.js';
import { PERMISSIONS } from '../src/modules/identity/domain/permissions.js';
import type { AdminAuditQueryService } from '../src/modules/admin-audit/admin-audit-query.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '99999999-9999-4999-8999-999999999999';
const adminId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const licenseId = '22222222-2222-4222-8222-222222222222';
const deviceId = '33333333-3333-4333-8333-333333333333';
const now = new Date('2026-08-24T15:00:00.000Z');
let app: FastifyInstance | undefined;
afterEach(async () => { if (app !== undefined) { await app.close(); app = undefined; } });

describe('eighth-stage admin audit routes', () => {
  it('requires audit.read for both query endpoints', async () => {
    let called = false;
    app = buildApp({ adminAudit: dependencies(new Set(), {
      listAuditLogs: async () => { called = true; return { items: [], total: 0 }; },
      listLicenseEvents: async () => { called = true; return { items: [], total: 0 }; },
    }) });

    const auditResponse = await app.inject({ method: 'GET', url: '/admin/v1/audit-logs', headers: adminHeaders() });
    const eventResponse = await app.inject({ method: 'GET', url: '/admin/v1/license-events', headers: adminHeaders() });

    expect(auditResponse.statusCode).toBe(403);
    expect(eventResponse.statusCode).toBe(403);
    expect(auditResponse.json()).toMatchObject({ code: 'ADMIN_FORBIDDEN' });
    expect(called).toBe(false);
  });

  it('passes audit filters and returns snake-case audit records', async () => {
    let received: unknown;
    app = buildApp({ adminAudit: dependencies(new Set([PERMISSIONS.AUDIT_READ]), {
      listAuditLogs: async (_context: unknown, filters: unknown) => { received = filters; return { items: [auditRecord()], total: 17 }; },
    }) });

    const response = await app.inject({
      method: 'GET',
      url: '/admin/v1/audit-logs?action=device.block&result=SUCCESS&occurred_from=2026-08-01T00%3A00%3A00.000Z&limit=20&offset=5',
      headers: adminHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(received).toMatchObject({ action: 'device.block', result: 'SUCCESS', limit: 20, offset: 5 });
    expect(response.json()).toMatchObject({
      success: true,
      data: { items: [{ id: '101', tenant_id: tenantId, action: 'device.block', before_data: { status: 'ACTIVE' } }], total: 17, limit: 20, offset: 5 },
    });
  });

  it('passes license-event filters and returns authorization history', async () => {
    let received: unknown;
    app = buildApp({ adminAudit: dependencies(new Set([PERMISSIONS.AUDIT_READ]), {
      listLicenseEvents: async (_context: unknown, filters: unknown) => { received = filters; return { items: [licenseEventRecord()], total: 23 }; },
    }) });

    const response = await app.inject({
      method: 'GET',
      url: `/admin/v1/license-events?license_id=${licenseId}&device_id=${deviceId}&event_type=ADMIN_DEVICE_BLOCKED`,
      headers: adminHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(received).toMatchObject({ licenseId, deviceId, eventType: 'ADMIN_DEVICE_BLOCKED', limit: 50, offset: 0 });
    expect(response.json()).toMatchObject({
      success: true,
      data: { items: [{ id: '202', license_id: licenseId, device_id: deviceId, event_type: 'ADMIN_DEVICE_BLOCKED' }], total: 23 },
    });
  });

  it('rejects an inverted time range before running the service', async () => {
    let called = false;
    app = buildApp({ adminAudit: dependencies(new Set([PERMISSIONS.AUDIT_READ]), {
      listAuditLogs: async () => { called = true; return { items: [], total: 0 }; },
    }) });
    const response = await app.inject({
      method: 'GET',
      url: '/admin/v1/audit-logs?occurred_from=2026-08-24T10%3A00%3A00Z&occurred_to=2026-08-23T10%3A00%3A00Z',
      headers: adminHeaders(),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(called).toBe(false);
  });

  it('enforces tenant isolation before running the service', async () => {
    let called = false;
    app = buildApp({ adminAudit: dependencies(new Set([PERMISSIONS.AUDIT_READ]), {
      listLicenseEvents: async () => { called = true; return { items: [], total: 0 }; },
    }) });
    const response = await app.inject({
      method: 'GET', url: '/admin/v1/license-events',
      headers: { ...adminHeaders(), 'x-tenant-id': otherTenantId },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'TENANT_ACCESS_DENIED' });
    expect(called).toBe(false);
  });

  it('keeps step-nine and excluded systems outside step eight', async () => {
    app = buildApp({ adminAudit: dependencies(new Set([PERMISSIONS.AUDIT_READ]), {}) });
    for (const request of [
      { method: 'POST' as const, url: '/admin/v1/orders' },
      { method: 'GET' as const, url: '/admin' },
      { method: 'POST' as const, url: '/admin/v1/signing-keys' },
      { method: 'POST' as const, url: '/admin/v1/agents' },
      { method: 'DELETE' as const, url: '/admin/v1/audit-logs/101' },
      { method: 'POST' as const, url: '/admin/v1/system-settings' },
    ]) {
      const response = await app.inject({ ...request, headers: adminHeaders() });
      expect(response.statusCode).toBe(404);
    }
  });
});

function dependencies(permissions: ReadonlySet<string>, serviceMethods: Record<string, unknown>) {
  const principalResolver: AdminPrincipalResolver = { resolve: async () => ({ userId: adminId, tenantId, permissions }) };
  return { principalResolver, auditQueryService: serviceMethods as unknown as AdminAuditQueryService };
}
function adminHeaders() { return { authorization: 'Bearer test', 'x-admin-user-id': adminId }; }
function auditRecord() { return {
  id: '101', tenantId, actorType: 'ADMIN_USER' as const, actorId: adminId, action: 'device.block',
  resourceType: 'DEVICE', resourceId: deviceId, requestId: 'request-old', sourceIp: '127.0.0.1', userAgent: 'vitest',
  result: 'SUCCESS' as const, beforeData: { status: 'ACTIVE' }, afterData: { status: 'BLOCKED' }, metadata: {}, occurredAt: now,
}; }
function licenseEventRecord() { return {
  id: '202', tenantId, productId: null, licenseId, deviceId, activationId: null, sessionId: null,
  eventType: 'ADMIN_DEVICE_BLOCKED', result: 'SUCCESS' as const, reasonCode: 'ADMIN_BLOCKED', requestId: 'request-event',
  ipAddress: '127.0.0.1', metadata: {}, occurredAt: now,
}; }

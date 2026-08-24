import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { AdminPrincipalResolver } from '../src/modules/identity/admin-principal.js';
import { PERMISSIONS } from '../src/modules/identity/domain/permissions.js';
import type { AdminDeviceManagementService } from '../src/modules/admin-devices/admin-device-management.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '99999999-9999-4999-8999-999999999999';
const adminId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const deviceId = '22222222-2222-4222-8222-222222222222';
const licenseId = '33333333-3333-4333-8333-333333333333';
const activationId = '44444444-4444-4444-8444-444444444444';
let app: FastifyInstance | undefined;
afterEach(async () => { if (app !== undefined) { await app.close(); app = undefined; } });

describe('seventh-stage admin device routes', () => {
  it('requires devices.read before listing a Key devices', async () => {
    let called = false;
    app = buildApp({ adminDevices: dependencies(new Set(), { listLicenseDevices: async () => { called = true; return { items: [], total: 0 }; } }) });
    const response = await app.inject({ method: 'GET', url: `/admin/v1/license-keys/${licenseId}/devices`, headers: adminHeaders() });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ success: false, code: 'ADMIN_FORBIDDEN' });
    expect(called).toBe(false);
  });

  it('lists device history with devices.read', async () => {
    app = buildApp({ adminDevices: dependencies(new Set([PERMISSIONS.DEVICES_READ]), {
      listLicenseDevices: async () => ({ items: [binding()], total: 7 }),
    }) });
    const response = await app.inject({ method: 'GET', url: `/admin/v1/license-keys/${licenseId}/devices?activation_status=ACTIVE`, headers: adminHeaders() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ success: true, data: { items: [{ device_id: deviceId, activation_status: 'ACTIVE', active_session_count: 1 }] } });
  });

  it('requires devices.unbind for force-unbind and passes the selected license', async () => {
    let receivedLicenseId: string | undefined;
    app = buildApp({ adminDevices: dependencies(new Set([PERMISSIONS.DEVICES_UNBIND]), {
      forceUnbind: async (_context: unknown, _deviceId: string, selectedLicenseId: string) => {
        receivedLicenseId = selectedLicenseId;
        return { unbound: true, changed: true, license_id: selectedLicenseId, device_id: deviceId, activation_id: activationId,
          activation_status: 'UNBOUND', revoked_session_count: 2, unbound_at: '2026-08-24T14:00:00.000Z' };
      },
    }) });
    const response = await app.inject({ method: 'POST', url: `/admin/v1/devices/${deviceId}/unbind`, headers: adminHeaders(), payload: { license_id: licenseId, reason: '换机' } });
    expect(response.statusCode).toBe(200);
    expect(receivedLicenseId).toBe(licenseId);
    expect(response.json()).toMatchObject({ success: true, data: { unbound: true, revoked_session_count: 2 } });
  });

  it('uses devices.block for both block and unblock', async () => {
    const calls: string[] = [];
    app = buildApp({ adminDevices: dependencies(new Set([PERMISSIONS.DEVICES_BLOCK]), {
      block: async () => { calls.push('block'); return { blocked: true, changed: true, device_id: deviceId, device_status: 'BLOCKED',
        block_id: '55555555-5555-4555-8555-555555555555', blocked_activation_count: 1, revoked_session_count: 1, blocked_at: '2026-08-24T14:00:00.000Z' }; },
      unblock: async () => { calls.push('unblock'); return { unblocked: true, changed: true, device_id: deviceId, device_status: 'ACTIVE',
        released_block_count: 1, released_at: '2026-08-24T14:00:00.000Z', old_bindings_restored: false, old_sessions_restored: false }; },
    }) });
    const block = await app.inject({ method: 'POST', url: `/admin/v1/devices/${deviceId}/block`, headers: adminHeaders(), payload: { reason: '风险设备' } });
    const unblock = await app.inject({ method: 'POST', url: `/admin/v1/devices/${deviceId}/unblock`, headers: adminHeaders(), payload: { reason: '复核通过' } });
    expect(block.statusCode).toBe(200);
    expect(unblock.statusCode).toBe(200);
    expect(unblock.json()).toMatchObject({ data: { old_bindings_restored: false, old_sessions_restored: false } });
    expect(calls).toEqual(['block', 'unblock']);
  });

  it('rejects another tenant before executing device service', async () => {
    let called = false;
    app = buildApp({ adminDevices: dependencies(new Set([PERMISSIONS.DEVICES_BLOCK]), { block: async () => { called = true; throw new Error('must not run'); } }) });
    const response = await app.inject({ method: 'POST', url: `/admin/v1/devices/${deviceId}/block`, headers: { ...adminHeaders(), 'x-tenant-id': otherTenantId }, payload: { reason: '风险设备' } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'TENANT_ACCESS_DENIED' });
    expect(called).toBe(false);
  });

  it('keeps payment, admin pages and signing-key management outside step seven', async () => {
    app = buildApp({ adminDevices: dependencies(new Set([PERMISSIONS.DEVICES_BLOCK]), {}) });
    for (const request of [
      { method: 'POST' as const, url: '/admin/v1/orders' },
      { method: 'GET' as const, url: '/admin' },
      { method: 'POST' as const, url: '/admin/v1/signing-keys' },
      { method: 'POST' as const, url: '/admin/v1/agents' },
    ]) {
      const response = await app.inject({ ...request, headers: adminHeaders() });
      expect(response.statusCode).toBe(404);
    }
  });
});

function dependencies(permissions: ReadonlySet<string>, serviceMethods: Record<string, unknown>) {
  const principalResolver: AdminPrincipalResolver = { resolve: async () => ({ userId: adminId, tenantId, permissions }) };
  return { principalResolver, deviceService: serviceMethods as unknown as AdminDeviceManagementService };
}
function adminHeaders() { return { authorization: 'Bearer test', 'x-admin-user-id': adminId }; }
function binding() {
  const now = new Date('2026-08-24T14:00:00.000Z');
  return { deviceId, tenantId, licenseId, activationId, deviceStatus: 'ACTIVE' as const, activationStatus: 'ACTIVE' as const,
    platform: 'windows', osVersion: '11', displayName: '办公室电脑', devicePublicKeyFingerprint: 'key-fp', fingerprintHash: 'hardware-fp',
    riskScore: 0, firstSeenAt: now, lastSeenAt: now, activatedAt: now, lastVerifiedAt: now, unboundAt: null,
    activeSessionCount: 1, blocked: false, blockReason: null, blockedAt: null };
}

import { describe, expect, it } from 'vitest';
import type { AuditEvent, AuditLogPort } from '../src/modules/audit/audit-log.port.js';
import type { AdminSessionStore } from '../src/modules/admin-auth/admin-session.store.js';
import { hashAdminPassword } from '../src/modules/admin-auth/admin-password.js';
import type { AdminConsoleRepository } from '../src/modules/admin-console/admin-console.repository.js';
import { AdminConsoleService } from '../src/modules/admin-console/admin-console.service.js';
import type { ManagementRequestContext } from '../src/modules/identity/admin-principal.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const adminId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherAdminId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const context: ManagementRequestContext = {
  principal: { userId: adminId, tenantId, permissions: new Set() },
  tenantId,
  requestId: 'request-1',
  sourceIp: '127.0.0.1',
};

function dependencies(repositoryMethods: Record<string, unknown> = {}) {
  const destroyed: string[] = [];
  const events: AuditEvent[] = [];
  const repository = repositoryMethods as unknown as AdminConsoleRepository;
  const sessions = { destroy: async (token: string) => { destroyed.push(token); } } as unknown as AdminSessionStore;
  const auditLog: AuditLogPort = { append: async (event) => { events.push(event); } };
  return { service: new AdminConsoleService(repository, sessions, auditLog), destroyed, events };
}

describe('管理后台成熟化服务', () => {
  it('禁止管理员停用自己或修改自己的角色', async () => {
    let called = false;
    const { service } = dependencies({ updateAdmin: async () => { called = true; } });
    await expect(service.updateAdmin(context, adminId, { status: 'SUSPENDED' })).rejects.toMatchObject({ code: 'SELF_LOCKOUT_FORBIDDEN' });
    await expect(service.updateAdmin(context, adminId, { roleIds: ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'] })).rejects.toMatchObject({ code: 'SELF_LOCKOUT_FORBIDDEN' });
    expect(called).toBe(false);
  });

  it('禁止通过管理员列表重置自己的密码', async () => {
    const { service } = dependencies();
    await expect(service.resetPassword(context, adminId, 'Another-Strong-Password-123')).rejects.toMatchObject({ code: 'USE_CHANGE_PASSWORD' });
  });

  it('修改自己的密码后销毁当前会话并记录审计', async () => {
    const oldHash = await hashAdminPassword('Old-Strong-Password-123');
    let replaced = false;
    const { service, destroyed, events } = dependencies({
      passwordRecord: async () => ({ password_hash: oldHash, session_version: 3 }),
      replacePassword: async (userId: string, passwordHash: string) => {
        expect(userId).toBe(adminId);
        expect(passwordHash).not.toBe(oldHash);
        replaced = true;
        return 4;
      },
    });
    await expect(service.changeOwnPassword(context, 'session-token', 'Old-Strong-Password-123', 'New-Strong-Password-456')).resolves.toEqual({ changed: true, loginRequired: true });
    expect(replaced).toBe(true);
    expect(destroyed).toEqual(['session-token']);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'ADMIN_PASSWORD_CHANGE', resourceId: adminId, result: 'SUCCESS' });
  });

  it('重置其他管理员密码后标记旧会话失效并记录审计', async () => {
    const target = {
      id: otherAdminId, email: 'operator@example.com', displayName: '运营员', status: 'ACTIVE' as const,
      mfaRequired: false, lastLoginAt: null, passwordChangedAt: null,
      createdAt: new Date('2026-08-24T00:00:00.000Z'), updatedAt: new Date('2026-08-24T00:00:00.000Z'),
      roles: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', code: 'operator', name: '运营员' }],
    };
    let replaced = false;
    const { service, events } = dependencies({
      findAdmin: async () => target,
      replacePassword: async (userId: string) => { expect(userId).toBe(otherAdminId); replaced = true; return 2; },
    });
    await expect(service.resetPassword(context, otherAdminId, 'Reset-Strong-Password-789')).resolves.toEqual({ reset: true, sessionInvalidated: true });
    expect(replaced).toBe(true);
    expect(events[0]).toMatchObject({ action: 'ADMIN_PASSWORD_RESET', resourceId: otherAdminId, after: { session_invalidated: true } });
  });
});

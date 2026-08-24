import { describe, expect, it } from 'vitest';
import type { PostgresDatabase } from '../src/infrastructure/database/postgres-database.js';
import { PostgresAdminPrincipalResolver } from '../src/modules/identity/infrastructure/postgres-admin-principal.resolver.js';

const token = 'management-gateway-token-longer-than-32-characters';

describe('PostgresAdminPrincipalResolver', () => {
  it('rejects access before querying PostgreSQL when the gateway token is wrong', async () => {
    let queried = false;
    const database = { query: async () => { queried = true; return { rows: [] }; } } as unknown as PostgresDatabase;
    const resolver = new PostgresAdminPrincipalResolver(database, token);
    await expect(resolver.resolve({ authorization: 'Bearer wrong', adminUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }))
      .rejects.toThrowError(/身份验证失败/);
    expect(queried).toBe(false);
  });

  it('loads active administrator permissions from PostgreSQL', async () => {
    const database = { query: async () => ({ rows: [
      { user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', tenant_id: '11111111-1111-4111-8111-111111111111', permission_code: 'products.read' },
      { user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', tenant_id: '11111111-1111-4111-8111-111111111111', permission_code: 'products.write' },
    ] }) } as unknown as PostgresDatabase;
    const resolver = new PostgresAdminPrincipalResolver(database, token);
    const principal = await resolver.resolve({ authorization: `Bearer ${token}`, adminUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    expect(principal.tenantId).toBe('11111111-1111-4111-8111-111111111111');
    expect(principal.permissions).toEqual(new Set(['products.read', 'products.write']));
  });
});

import { describe, expect, it } from 'vitest';
import type { AuditLogPort } from '../src/modules/audit/audit-log.port.js';
import { ProductManagementService } from '../src/modules/products/product-management.service.js';
import type { LicensePolicy, ProductRepository } from '../src/modules/products/product.repository.js';

const context = {
  principal: { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', tenantId: '11111111-1111-4111-8111-111111111111', permissions: new Set<string>() },
  tenantId: '11111111-1111-4111-8111-111111111111', requestId: 'request-policy',
};
const audit: AuditLogPort = { append: async () => undefined };

describe('ProductManagementService policy validation', () => {
  it('accepts a duration policy and rejects missing duration', async () => {
    const service = new ProductManagementService(repository(), audit);
    await expect(service.createPolicy(context, {
      productId: null, code: 'standard-30d', name: '标准 30 天', licenseType: 'DURATION', durationSeconds: 2_592_000,
      maxDevices: 1, maxConcurrentSessions: 1, offlineGraceSeconds: 86400, allowSelfUnbind: false,
      unbindCooldownSeconds: 604800, rules: {}, status: 'ACTIVE',
    })).resolves.toMatchObject({ licenseType: 'DURATION', durationSeconds: 2_592_000 });

    await expect(service.createPolicy(context, {
      productId: null, code: 'invalid', name: '无效', licenseType: 'DURATION', durationSeconds: null,
      maxDevices: 1, maxConcurrentSessions: 1, offlineGraceSeconds: 86400, allowSelfUnbind: false,
      unbindCooldownSeconds: 604800, rules: {}, status: 'ACTIVE',
    })).rejects.toThrowError(/必须设置有效时长/);
  });

  it('requires a future fixed expiry and keeps perpetual policies timeless', async () => {
    const service = new ProductManagementService(repository(), audit);
    await expect(service.createPolicy(context, {
      productId: null, code: 'fixed', name: '固定到期', licenseType: 'FIXED_EXPIRY', durationSeconds: null,
      maxDevices: 1, maxConcurrentSessions: 1, offlineGraceSeconds: 86400, allowSelfUnbind: false,
      unbindCooldownSeconds: 604800, rules: { fixed_expires_at: '2026-08-23T00:00:00Z' }, status: 'ACTIVE',
    }, new Date('2026-08-24T00:00:00Z'))).rejects.toThrowError(/未来/);

    await expect(service.createPolicy(context, {
      productId: null, code: 'forever', name: '永久', licenseType: 'PERPETUAL', durationSeconds: null,
      maxDevices: 1, maxConcurrentSessions: 1, offlineGraceSeconds: 86400, allowSelfUnbind: false,
      unbindCooldownSeconds: 604800, rules: { fixed_expires_at: '2027-01-01T00:00:00Z' }, status: 'ACTIVE',
    })).rejects.toThrowError(/永久授权不能设置固定到期时间/);
  });
});

function repository(): ProductRepository {
  return {
    createPolicy: async (input) => ({
      id: '22222222-2222-4222-8222-222222222222', tenantId: input.tenantId, productId: input.productId ?? null,
      code: input.code, name: input.name, licenseType: input.licenseType, durationSeconds: input.durationSeconds ?? null,
      maxDevices: input.maxDevices, maxConcurrentSessions: input.maxConcurrentSessions, offlineGraceSeconds: input.offlineGraceSeconds,
      allowSelfUnbind: input.allowSelfUnbind, unbindCooldownSeconds: input.unbindCooldownSeconds, rules: input.rules,
      status: input.status, createdAt: new Date('2026-08-24T00:00:00Z'), updatedAt: new Date('2026-08-24T00:00:00Z'),
    } satisfies LicensePolicy),
  } as ProductRepository;
}

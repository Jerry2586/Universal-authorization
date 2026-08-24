import { describe, expect, it } from 'vitest';
import type { AuditEvent, AuditLogPort } from '../src/modules/audit/audit-log.port.js';
import { HmacLicenseKeyCodec } from '../src/modules/licenses/license-key-codec.js';
import { LicenseManagementService } from '../src/modules/licenses/license-management.service.js';
import type {
  CreateLicenseBatchInput,
  LicenseGenerationContext,
  LicenseListInput,
  LicenseRepository,
  ManagedLicenseKey,
} from '../src/modules/licenses/license.repository.js';
import type { LicenseStatus } from '../src/modules/licenses/domain/license-key.js';

class MemoryAudit implements AuditLogPort {
  public readonly events: AuditEvent[] = [];
  public async append(event: AuditEvent): Promise<void> { this.events.push(event); }
}

class MemoryLicenseRepository implements LicenseRepository {
  public readonly licenses = new Map<string, ManagedLicenseKey>();
  public lastCreateInput?: CreateLicenseBatchInput;
  public generation: LicenseGenerationContext = {
    productStatus: 'ACTIVE',
    policy: {
      id: '22222222-2222-4222-8222-222222222222', tenantId: '11111111-1111-4111-8111-111111111111',
      productId: '33333333-3333-4333-8333-333333333333', code: 'standard-30d', name: '标准 30 天',
      licenseType: 'DURATION', durationSeconds: 2_592_000, maxDevices: 1, maxConcurrentSessions: 1,
      offlineGraceSeconds: 86_400, allowSelfUnbind: false, unbindCooldownSeconds: 604_800,
      rules: {}, status: 'ACTIVE', createdAt: new Date('2026-08-24T00:00:00Z'), updatedAt: new Date('2026-08-24T00:00:00Z'),
    },
  };

  public async getGenerationContext(): Promise<LicenseGenerationContext | null> { return this.generation; }
  public async createBatch(input: CreateLicenseBatchInput): Promise<readonly ManagedLicenseKey[]> {
    this.lastCreateInput = input;
    return input.preparedKeys.map((prepared, index) => {
      const license = makeLicense({
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        keyPrefix: prepared.keyPrefix, keySuffix: prepared.keySuffix, policyId: input.policyId,
        generationBatchId: input.generationBatchId, licenseType: input.licenseType,
        durationSeconds: input.durationSeconds, maxDevices: input.maxDevices, maxConcurrentSessions: input.maxConcurrentSessions,
        offlineGraceSeconds: input.offlineGraceSeconds, allowSelfUnbind: input.allowSelfUnbind,
        unbindCooldownSeconds: input.unbindCooldownSeconds, metadata: input.metadata, expiresAt: input.expiresAt,
      });
      this.licenses.set(license.id, license);
      return license;
    });
  }
  public async findById(_tenantId: string, licenseId: string): Promise<ManagedLicenseKey | null> { return this.licenses.get(licenseId) ?? null; }
  public async list(_input: LicenseListInput): Promise<{ items: readonly ManagedLicenseKey[]; total: number }> {
    const items = [...this.licenses.values()];
    return { items, total: items.length };
  }
  public async changeStatus(
    _tenantId: string, licenseId: string, expected: readonly LicenseStatus[], status: LicenseStatus,
    changes: { suspendedFromStatus?: LicenseStatus | null; revokedAt?: Date | null; expiresAt?: Date | null } = {},
  ): Promise<ManagedLicenseKey | null> {
    const current = this.licenses.get(licenseId); if (current === undefined || !expected.includes(current.status)) return null;
    const updated: ManagedLicenseKey = { ...current, status,
      ...(Object.prototype.hasOwnProperty.call(changes, 'revokedAt') ? { revokedAt: changes.revokedAt ?? null } : {}),
      ...(Object.prototype.hasOwnProperty.call(changes, 'expiresAt') ? { expiresAt: changes.expiresAt ?? null } : {}),
      updatedAt: new Date('2026-08-24T12:00:00Z') };
    this.licenses.set(licenseId, updated); return updated;
  }
}

const context = {
  principal: { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', tenantId: '11111111-1111-4111-8111-111111111111', permissions: new Set<string>() },
  tenantId: '11111111-1111-4111-8111-111111111111', requestId: 'request-1',
};

describe('LicenseManagementService', () => {
  it('generates a batch, snapshots policy limits, and never audits plaintext Keys', async () => {
    const repository = new MemoryLicenseRepository(); const audit = new MemoryAudit();
    const service = new LicenseManagementService(repository, new HmacLicenseKeyCodec('test-pepper-that-is-longer-than-32-characters'), audit);
    const delivery = await service.generate(context, {
      productId: '33333333-3333-4333-8333-333333333333', policyId: '22222222-2222-4222-8222-222222222222',
      count: 2, metadata: { order: 'A-1' }, features: [],
    });

    expect(delivery.items).toHaveLength(2);
    expect(delivery.items[0]?.plainKey).toMatch(/^ULK1-/);
    expect(repository.lastCreateInput?.preparedKeys[0]?.keyHash).toMatch(/^hmac-sha256:/);
    expect(repository.lastCreateInput).toMatchObject({ maxDevices: 1, maxConcurrentSessions: 1, offlineGraceSeconds: 86400 });
    const auditJson = JSON.stringify(audit.events);
    for (const item of delivery.items) expect(auditJson).not.toContain(item.plainKey);
  });

  it('enforces freeze, resume, renewal, and irreversible revoke transitions', async () => {
    const repository = new MemoryLicenseRepository(); const audit = new MemoryAudit();
    const service = new LicenseManagementService(repository, new HmacLicenseKeyCodec('test-pepper-that-is-longer-than-32-characters'), audit);
    const id = '99999999-9999-4999-8999-999999999999';
    repository.licenses.set(id, makeLicense({ id, status: 'ACTIVE', startsAt: new Date('2026-08-01T00:00:00Z'), expiresAt: new Date('2026-09-01T00:00:00Z') }));

    await expect(service.suspend(context, id)).resolves.toMatchObject({ status: 'SUSPENDED' });
    await expect(service.resume(context, id, new Date('2026-08-24T00:00:00Z'))).resolves.toMatchObject({ status: 'ACTIVE' });
    await expect(service.renew(context, id, { extendSeconds: 86400 }, new Date('2026-08-24T00:00:00Z')))
      .resolves.toMatchObject({ status: 'ACTIVE', expiresAt: new Date('2026-09-02T00:00:00Z') });
    await expect(service.revoke(context, id, '泄露', new Date('2026-08-24T01:00:00Z'))).resolves.toMatchObject({ status: 'REVOKED' });
    await expect(service.resume(context, id)).rejects.toThrowError(/不能从 REVOKED/);
  });
});

function makeLicense(overrides: Partial<ManagedLicenseKey> = {}): ManagedLicenseKey {
  return {
    id: '99999999-9999-4999-8999-999999999999', tenantId: '11111111-1111-4111-8111-111111111111',
    productId: '33333333-3333-4333-8333-333333333333', policyId: '22222222-2222-4222-8222-222222222222',
    generationBatchId: null, keyPrefix: 'ULK1-ABCD', keySuffix: 'WXYZ', status: 'CREATED', licenseType: 'DURATION',
    startsAt: null, expiresAt: null, durationSeconds: 2_592_000, maxDevices: 1, maxConcurrentSessions: 1, offlineGraceSeconds: 86400,
    allowSelfUnbind: false, unbindCooldownSeconds: 604800, metadata: {}, features: [],
    createdAt: new Date('2026-08-24T00:00:00Z'), activatedAt: null, revokedAt: null, updatedAt: new Date('2026-08-24T00:00:00Z'),
    ...overrides,
  };
}


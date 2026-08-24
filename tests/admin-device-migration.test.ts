import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationPath = new URL('../database/migrations/0006_admin_device_management_stage.sql', import.meta.url);
const repositoryPath = new URL('../src/modules/admin-devices/infrastructure/postgres-admin-device.repository.ts', import.meta.url);

describe('seventh-stage admin device database changes', () => {
  it('adds only device-management indexes without recreating history tables', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    expect(sql).toContain('activations_tenant_license_time_idx');
    expect(sql).toContain('activations_tenant_device_status_idx');
    expect(sql).toContain('device_blocks_tenant_device_status_idx');
    for (const table of ['devices', 'activations', 'device_blocks', 'license_sessions', 'license_events', 'audit_logs']) {
      expect(sql).not.toMatch(new RegExp(`CREATE TABLE ${table}`, 'i'));
    }
  });

  it('preserves history, revokes live sessions and never changes the Key expiry', async () => {
    const source = await readFile(repositoryPath, 'utf8');
    expect(source).toMatch(/UPDATE activations[\s\S]*SET status='UNBOUND'/);
    expect(source).toMatch(/UPDATE activations SET status='BLOCKED'/);
    expect(source).toMatch(/UPDATE license_sessions[\s\S]*status='REVOKED'/);
    expect(source).toMatch(/UPDATE device_blocks[\s\S]*status='RELEASED'/);
    expect(source).toContain('ADMIN_DEVICE_UNBOUND');
    expect(source).toContain('ADMIN_DEVICE_BLOCKED');
    expect(source).toContain('ADMIN_DEVICE_UNBLOCKED');
    expect(source).not.toMatch(/DELETE FROM (devices|activations|device_blocks|license_sessions)/i);
    expect(source).not.toMatch(/UPDATE license_keys SET expires_at/i);
  });
});

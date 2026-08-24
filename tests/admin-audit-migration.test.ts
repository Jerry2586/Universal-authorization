import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationPath = new URL('../database/migrations/0007_admin_audit_query_stage.sql', import.meta.url);
const repositoryPath = new URL('../src/modules/admin-audit/infrastructure/postgres-admin-audit-query.repository.ts', import.meta.url);

describe('eighth-stage admin audit query database changes', () => {
  it('adds read indexes without changing or deleting historical records', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    expect(sql).toContain('audit_logs_tenant_action_time_idx');
    expect(sql).toContain('audit_logs_tenant_result_time_idx');
    expect(sql).toContain('license_events_tenant_license_time_idx');
    expect(sql).toContain('license_events_tenant_device_time_idx');
    expect(sql).toContain('license_events_tenant_type_time_idx');
    expect(sql).not.toMatch(/\b(DELETE|TRUNCATE|DROP)\b/i);
    expect(sql).not.toMatch(/CREATE TABLE\s+(audit_logs|license_events)/i);
  });

  it('keeps every PostgreSQL query tenant-scoped, parameterized and read-only', async () => {
    const source = await readFile(repositoryPath, 'utf8');
    expect(source).toContain("const conditions = ['tenant_id = $1']");
    expect(source).toContain('FROM audit_logs');
    expect(source).toContain('FROM license_events');
    expect(source).toContain('ORDER BY occurred_at DESC, id DESC');
    expect(source).toContain('LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}');
    expect(source).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP)\b/i);
  });
});

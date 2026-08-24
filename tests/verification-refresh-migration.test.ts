import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('fifth-stage migration', () => {
  it('adds refresh idempotency without changing older migrations', async () => {
    const sql = await readFile(new URL('../database/migrations/0004_verification_refresh_stage.sql', import.meta.url), 'utf8');
    expect(sql).toContain('CREATE TABLE license_refresh_idempotency_records');
    expect(sql).toContain("status IN ('PROCESSING', 'COMPLETED')");
    expect(sql).toContain('license_refresh_idempotency_expiry_idx');
    expect(sql).not.toContain('session_heartbeats');
    expect(sql).not.toContain('device_blocks');
  });
});

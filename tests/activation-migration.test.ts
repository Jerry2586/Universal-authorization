import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('fourth-stage database migration', () => {
  it('adds durable activation idempotency without storing a plaintext Key', async () => {
    const sql = await readFile(resolve(process.cwd(), 'database', 'migrations', '0003_activation_stage.sql'), 'utf8');
    expect(sql).toMatch(/CREATE TABLE activation_idempotency_records/i);
    expect(sql).toMatch(/idempotency_key VARCHAR\(128\) PRIMARY KEY/i);
    expect(sql).toMatch(/request_hash VARCHAR\(64\) NOT NULL/i);
    expect(sql).toMatch(/response_data JSONB/i);
    expect(sql).toMatch(/status IN \('PROCESSING', 'COMPLETED'\)/i);
    expect(sql).not.toMatch(/license_key\s+(TEXT|VARCHAR)/i);
  });
});


import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('third-stage database migration', () => {
  it('adds immutable policy snapshots and a generation batch identifier', async () => {
    const sql = await readFile(resolve(process.cwd(), 'database', 'migrations', '0002_management_stage.sql'), 'utf8');
    expect(sql).toMatch(/generation_batch_id UUID/i);
    expect(sql).toMatch(/duration_seconds BIGINT/i);
    expect(sql).toMatch(/offline_grace_seconds INTEGER NOT NULL/i);
    expect(sql).toMatch(/allow_self_unbind BOOLEAN NOT NULL/i);
    expect(sql).toMatch(/unbind_cooldown_seconds INTEGER NOT NULL/i);
    expect(sql).toMatch(/suspended_from_status VARCHAR\(24\)/i);
  });
});


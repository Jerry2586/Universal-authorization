import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationPath = new URL('../database/migrations/0005_session_lifecycle_stage.sql', import.meta.url);
const repositoryPath = new URL('../src/modules/verification/infrastructure/postgres-license-runtime.repository.ts', import.meta.url);
const policyPath = new URL('../src/modules/devices/device-unbind.policy.ts', import.meta.url);

describe('sixth-stage session lifecycle database changes', () => {
  it('adds heartbeat sequencing and action idempotency without recreating old tables', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    expect(sql).toContain('ALTER TABLE session_heartbeats');
    expect(sql).toContain('ADD COLUMN sequence BIGINT');
    expect(sql).toMatch(/CREATE TABLE session_action_idempotency_records/i);
    expect(sql).toContain('PRIMARY KEY (action_type, idempotency_key)');
    expect(sql).not.toMatch(/CREATE TABLE license_sessions/i);
    expect(sql).not.toMatch(/CREATE TABLE session_heartbeats/i);
  });

  it('enforces self-unbind policy, cooldown, history retention and revokes active sessions', async () => {
    const source = await readFile(repositoryPath, 'utf8');
    const policy = await readFile(policyPath, 'utf8');
    expect(policy).toMatch(/SELF_UNBIND_NOT_ALLOWED/);
    expect(policy).toMatch(/UNBIND_COOLDOWN_ACTIVE/);
    expect(policy).toContain('input.activatedAt.getTime() + input.cooldownSeconds');
    expect(source).toMatch(/UPDATE activations SET status = 'UNBOUND'/);
    expect(source).toMatch(/UPDATE license_sessions SET status = 'REVOKED'/);
    expect(source).not.toMatch(/DELETE FROM activations/);
    expect(source).not.toMatch(/DELETE FROM devices/);
    expect(source).not.toMatch(/UPDATE license_keys SET expires_at/);
  });
});

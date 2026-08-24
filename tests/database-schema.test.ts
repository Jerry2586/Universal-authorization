import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('initial database migration', () => {
  it('contains every second-stage infrastructure table', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'database', 'migrations', '0001_initial_schema.sql'),
      'utf8',
    );
    const requiredTables = [
      'tenants',
      'admin_users',
      'roles',
      'permissions',
      'products',
      'product_versions',
      'api_clients',
      'license_policies',
      'license_keys',
      'devices',
      'activations',
      'feature_definitions',
      'feature_grants',
      'license_sessions',
      'session_heartbeats',
      'device_blocks',
      'license_events',
      'signing_keys',
      'system_settings',
      'audit_logs',
    ];

    for (const table of requiredTables) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE ${table}\\s*\\(`, 'i'));
    }
  });

  it('stores a Key hash and display fragments rather than a plaintext Key column', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'database', 'migrations', '0001_initial_schema.sql'),
      'utf8',
    );

    expect(sql).toMatch(/key_hash VARCHAR\(128\) NOT NULL/i);
    expect(sql).toMatch(/key_prefix VARCHAR\(16\) NOT NULL/i);
    expect(sql).toMatch(/key_suffix VARCHAR\(16\) NOT NULL/i);
    expect(sql).not.toMatch(/\blicense_key\s+(VARCHAR|TEXT)/i);
  });

  it('does not store signing private-key material in PostgreSQL', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'database', 'migrations', '0001_initial_schema.sql'),
      'utf8',
    );

    expect(sql).toMatch(/provider_key_reference TEXT NOT NULL/i);
    expect(sql).toMatch(/public_key_pem TEXT NOT NULL/i);
    expect(sql).not.toMatch(/private_key/i);
  });
});

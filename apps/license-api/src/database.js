import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from './schema.js';

const MIGRATIONS = Object.freeze({
  admin_users: [
    ['display_name', "TEXT NOT NULL DEFAULT ''"],
    ['role', "TEXT NOT NULL DEFAULT 'support'"],
    ['permissions_json', "TEXT NOT NULL DEFAULT '[]'"],
    ['is_owner', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_login_at', 'TEXT'],
    ['last_login_ip', 'TEXT'],
    ['deleted_at', 'TEXT'],
    ['deleted_username', 'TEXT'],
  ],
  source_versions: [
    ['release_notes', "TEXT NOT NULL DEFAULT ''"],
    ['channel', "TEXT NOT NULL DEFAULT 'stable'"],
    ['release_kind', "TEXT NOT NULL DEFAULT 'feature'"],
    ['min_xboard_version', 'TEXT'],
    ['min_upgrade_version', 'TEXT'],
    ['rollback_allowed', 'INTEGER NOT NULL DEFAULT 1'],
    ['rollback_to', 'TEXT'],
    ['withdrawn_reason', 'TEXT'],
    ['published_at', 'TEXT'],
  ],
  build_jobs: [
    ['intent', "TEXT NOT NULL DEFAULT 'install'"],
    ['base_version', 'TEXT'],
  ],
  licenses: [
    ['max_activations', 'INTEGER NOT NULL DEFAULT 1'],
    ['key_encrypted', 'TEXT'],
  ],
});

function migrate(database) {
  const baselineVersion = '2026-09-23-v1.0.0-baseline';
  if (!database.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(baselineVersion)) {
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const [table, columns] of Object.entries(MIGRATIONS)) {
        const existing = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
        for (const [name, definition] of columns) {
          if (!existing.has(name)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
        }
      }
      database.exec(`UPDATE source_versions SET published_at = created_at WHERE status = 'active' AND published_at IS NULL`);
      database.exec(`UPDATE admin_users SET role = 'owner', is_owner = 1 WHERE id = (
        SELECT id FROM admin_users ORDER BY created_at ASC, id ASC LIMIT 1
      ) AND NOT EXISTS (SELECT 1 FROM admin_users WHERE is_owner = 1)`);
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(baselineVersion, new Date().toISOString());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  const encryptedKeyVersion = '2026-09-23-v1.2.0-license-key-encryption';
  if (!database.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(encryptedKeyVersion)) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const licenseColumns = new Set(database.prepare('PRAGMA table_info(licenses)').all().map((column) => column.name));
      if (!licenseColumns.has('key_encrypted')) database.exec('ALTER TABLE licenses ADD COLUMN key_encrypted TEXT');
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(encryptedKeyVersion, new Date().toISOString());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  const domainVersion = '2026-09-23-v1.0.0-domain-normalization';
  if (!database.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(domainVersion)) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const domainColumns = [
        ['licenses', 'bound_domain'],
        ['build_tickets', 'requested_domain'],
        ['builds', 'domain'],
        ['install_receipts', 'domain'],
        ['activations', 'domain'],
        ['build_jobs', 'requested_domain'],
        ['domain_migration_requests', 'previous_domain'],
        ['domain_migration_requests', 'requested_domain'],
      ];
      for (const [table, column] of domainColumns) {
        database.exec(`UPDATE ${table} SET ${column} = substr(${column}, 5) WHERE lower(${column}) LIKE 'www.%'`);
      }
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(domainVersion, new Date().toISOString());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec(SCHEMA);
  migrate(database);
  return database;
}

export function transaction(database, operation) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

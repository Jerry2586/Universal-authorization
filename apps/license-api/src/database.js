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
});

function migrate(database) {
  for (const [table, columns] of Object.entries(MIGRATIONS)) {
    const existing = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
    for (const [name, definition] of columns) {
      if (!existing.has(name)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }
  database.exec(`UPDATE source_versions SET published_at = created_at WHERE status = 'active' AND published_at IS NULL`);
  // Existing installs predate roles; the bootstrap administrator is the original owner.
  database.exec(`UPDATE admin_users SET role = 'owner', is_owner = 1 WHERE id = (
    SELECT id FROM admin_users ORDER BY created_at ASC, id ASC LIMIT 1
  ) AND NOT EXISTS (SELECT 1 FROM admin_users WHERE is_owner = 1)`);
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

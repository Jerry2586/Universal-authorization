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
    ['plan_id', 'TEXT REFERENCES license_plans(id)'],
  ],
  support_tickets: [
    ['closed_by_type', 'TEXT'],
    ['closed_by_id', 'TEXT'],
    ['close_reason', 'TEXT'],
    ['reopened_at', 'TEXT'],
    ['reopened_by', 'TEXT'],
  ],
  support_attachments: [
    ['visibility', "TEXT NOT NULL DEFAULT 'public'"],
    ['actor_type', "TEXT NOT NULL DEFAULT 'system'"],
    ['actor_id', 'TEXT'],
  ],
  file_cleanup_tasks: [
    ['completed_at', 'TEXT'],
  ],
  activations: [
    ['identity_mode', "TEXT NOT NULL DEFAULT 'legacy'"],
    ['installation_public_key_fingerprint', 'TEXT'],
  ],
});

function addMissingColumns(database, migrations = MIGRATIONS) {
  for (const [table, columns] of Object.entries(migrations)) {
    const existing = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
    for (const [name, definition] of columns) {
      if (!existing.has(name)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }
}

function runMigration(database, version, operation) {
  if (database.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(version)) return;
  database.exec('BEGIN IMMEDIATE');
  try {
    operation();
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function migrate(database) {
  const baselineVersion = '2026-09-23-v1.0.0-baseline';
  runMigration(database, baselineVersion, () => {
    addMissingColumns(database);
    database.exec(`UPDATE source_versions SET published_at = created_at WHERE status = 'active' AND published_at IS NULL`);
    database.exec(`UPDATE admin_users SET role = 'owner', is_owner = 1 WHERE id = (
      SELECT id FROM admin_users ORDER BY created_at ASC, id ASC LIMIT 1
    ) AND NOT EXISTS (SELECT 1 FROM admin_users WHERE is_owner = 1)`);
  });

  // Some production databases recorded the original baseline before later
  // additive columns were introduced. CREATE TABLE IF NOT EXISTS does not
  // reconcile an existing SQLite table, so perform one independent,
  // idempotent compatibility pass without rewriting any existing values.
  const reconciliationVersion = '2026-09-24-v1.2.5-additive-column-reconciliation';
  runMigration(database, reconciliationVersion, () => {
    addMissingColumns(database);
    database.exec(`UPDATE admin_users SET role = 'owner', is_owner = 1 WHERE id = (
      SELECT id FROM admin_users ORDER BY created_at ASC, id ASC LIMIT 1
    ) AND NOT EXISTS (SELECT 1 FROM admin_users WHERE is_owner = 1)`);
  });

  const encryptedKeyVersion = '2026-09-23-v1.2.0-license-key-encryption';
  runMigration(database, encryptedKeyVersion, () => {
    const licenseColumns = new Set(database.prepare('PRAGMA table_info(licenses)').all().map((column) => column.name));
    if (!licenseColumns.has('key_encrypted')) database.exec('ALTER TABLE licenses ADD COLUMN key_encrypted TEXT');
  });

  const supportLifecycleVersion = '2026-09-24-v1.2.10-support-ticket-lifecycle';
  runMigration(database, supportLifecycleVersion, () => addMissingColumns(database, {
    support_tickets: MIGRATIONS.support_tickets,
  }));

  const domainVersion = '2026-09-23-v1.0.0-domain-normalization';
  runMigration(database, domainVersion, () => {
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
  });

  const phaseFourLifecycleVersion = '2026-09-25-v1.2.14-events-erasure-support';
  runMigration(database, phaseFourLifecycleVersion, () => addMissingColumns(database, {
    support_attachments: MIGRATIONS.support_attachments,
    file_cleanup_tasks: MIGRATIONS.file_cleanup_tasks,
  }));

  const entitlementErasureVersion = '2026-09-24-v1.2.10-entitlements-erasure';
  runMigration(database, entitlementErasureVersion, () => {
    addMissingColumns(database, { licenses: MIGRATIONS.licenses });
    const now = new Date().toISOString();
    const insertPlan = database.prepare(`
      INSERT OR IGNORE INTO license_plans (
        id, code, name, status, capabilities_json, limits_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
    `);
    insertPlan.run(
      'plan_free', 'free', '免费版',
      JSON.stringify(['settings:read', 'protected:read', 'updates:read']),
      JSON.stringify({ max_builds_per_day: 1, max_activations: 1 }), now, now,
    );
    insertPlan.run(
      'plan_paid', 'paid', '付费版',
      JSON.stringify(['settings:read', 'settings:write', 'theme:enable', 'xboard:connect', 'protected:read', 'updates:read']),
      JSON.stringify({ max_builds_per_day: 10, max_activations: 3 }), now, now,
    );
    insertPlan.run(
      'plan_legacy', 'legacy', '历史兼容版',
      JSON.stringify(['settings:read', 'settings:write', 'theme:enable', 'xboard:connect', 'protected:read', 'updates:read']),
      JSON.stringify({ preserve_license_limits: true }), now, now,
    );
    database.prepare(`UPDATE licenses SET plan_id = 'plan_legacy' WHERE plan_id IS NULL`).run();
    database.exec('CREATE INDEX IF NOT EXISTS idx_licenses_plan ON licenses(plan_id)');
  });

  const installationProofVersion = '2026-09-24-v1.2.10-installation-proof';
  runMigration(database, installationProofVersion, () => addMissingColumns(database, {
    activations: MIGRATIONS.activations,
  }));

  const controlMigrationVersion = '2026-09-24-v1.2.10-control-plane-migration';
  runMigration(database, controlMigrationVersion, () => {
    // SCHEMA creates the additive tables first. Keeping a dedicated marker
    // makes production upgrade state and rollback diagnostics explicit.
    database.prepare('SELECT 1 FROM control_plane_identity LIMIT 1').get();
  });
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

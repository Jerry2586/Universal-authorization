import type { QueryResultRow } from 'pg';
import { loadConfig, loadLocalEnvFile } from '../src/config/env.js';
import { PostgresDatabase } from '../src/infrastructure/database/postgres-database.js';

interface MigrationStatusRow extends QueryResultRow {
  name: string;
  checksum: string;
  applied_at: Date;
}

loadLocalEnvFile();
const config = loadConfig();
const database = new PostgresDatabase({
  connectionString: config.databaseUrl,
  maxConnections: 1,
  idleTimeoutMs: config.databaseIdleTimeoutMs,
  connectionTimeoutMs: config.infrastructureConnectTimeoutMs,
  applicationName: 'universal-license-server-migration-status',
});

try {
  await database.connect();
  const tableExists = await database.query<{ exists: boolean } & QueryResultRow>(
    `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists`,
  );

  if (!tableExists.rows[0]?.exists) {
    console.log('No migrations have been applied.');
  } else {
    const result = await database.query<MigrationStatusRow>(
      'SELECT name, checksum, applied_at FROM schema_migrations ORDER BY name',
    );

    if (result.rowCount === 0) {
      console.log('No migrations have been applied.');
    } else {
      console.table(
        result.rows.map((row) => ({
          migration: row.name,
          checksum: row.checksum.slice(0, 12),
          appliedAt: row.applied_at.toISOString(),
        })),
      );
    }
  }
} finally {
  await database.close();
}


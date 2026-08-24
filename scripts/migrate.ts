import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QueryResultRow } from 'pg';
import { loadConfig, loadLocalEnvFile } from '../src/config/env.js';
import { PostgresDatabase } from '../src/infrastructure/database/postgres-database.js';

interface AppliedMigrationRow extends QueryResultRow {
  name: string;
  checksum: string;
}

loadLocalEnvFile();
const config = loadConfig();
const database = new PostgresDatabase({
  connectionString: config.databaseUrl,
  maxConnections: 1,
  idleTimeoutMs: config.databaseIdleTimeoutMs,
  connectionTimeoutMs: config.infrastructureConnectTimeoutMs,
  applicationName: 'universal-license-server-migrations',
});
const migrationsDirectory = resolve(process.cwd(), 'database', 'migrations');
const advisoryLockId = 1_406_241_001;

try {
  await database.connect();

  await database.withConnection(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name VARCHAR(255) PRIMARY KEY,
        checksum VARCHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query('SELECT pg_advisory_lock($1)', [advisoryLockId]);

    try {
      const appliedResult = await client.query<AppliedMigrationRow>(
        'SELECT name, checksum FROM schema_migrations ORDER BY name',
      );
      const applied = new Map(
        appliedResult.rows.map((migration) => [migration.name, migration.checksum]),
      );
      const migrationFiles = (await readdir(migrationsDirectory))
        .filter((fileName) => /^\d+_[a-z0-9_-]+\.sql$/i.test(fileName))
        .sort((left, right) => left.localeCompare(right));

      for (const fileName of migrationFiles) {
        const sql = await readFile(resolve(migrationsDirectory, fileName), 'utf8');
        const checksum = createHash('sha256').update(sql).digest('hex');
        const existingChecksum = applied.get(fileName);

        if (existingChecksum !== undefined) {
          if (existingChecksum !== checksum) {
            throw new Error(`Migration checksum mismatch: ${fileName}`);
          }

          console.log(`skip ${fileName}`);
          continue;
        }

        try {
          await client.query('BEGIN');
          await client.query(sql);
          await client.query(
            'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
            [fileName, checksum],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }

        console.log(`applied ${fileName}`);
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [advisoryLockId]);
    }
  });
} finally {
  await database.close();
}


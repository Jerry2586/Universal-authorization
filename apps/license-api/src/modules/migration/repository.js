import { newId } from '../../../../../packages/core/src/identifiers.js';

export function createControlMigrationRepository(database) {
  const queries = {
    identity: database.prepare(`SELECT * FROM control_plane_identity WHERE id = 'primary'`),
    insertIdentity: database.prepare(`
      INSERT INTO control_plane_identity (
        id, deployment_id, ownership_generation, status, active_migration_id, created_at, updated_at
      ) VALUES ('primary', ?, 1, 'active', NULL, ?, ?)
    `),
    insertMigration: database.prepare(`
      INSERT INTO control_migrations (
        id, direction, target_url, source_deployment_id, target_deployment_id,
        ownership_generation, status, operation_id, preflight_json, requested_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    migrationById: database.prepare(`SELECT * FROM control_migrations WHERE id = ?`),
    listMigrations: database.prepare(`SELECT * FROM control_migrations ORDER BY created_at DESC LIMIT ?`),
    updateMigration: database.prepare(`
      UPDATE control_migrations SET status = ?, preflight_json = ?, bundle_sha256 = ?,
        target_deployment_id = COALESCE(?, target_deployment_id), failure_code = ?, failure_message = ?,
        updated_at = ?, completed_at = ? WHERE id = ?
    `),
    bindMigration: database.prepare(`
      UPDATE control_plane_identity SET active_migration_id = ?, status = ?, updated_at = ? WHERE id = 'primary'
    `),
    activateIdentity: database.prepare(`
      UPDATE control_plane_identity SET deployment_id = ?, ownership_generation = ?, status = 'active',
        active_migration_id = NULL, updated_at = ? WHERE id = 'primary'
    `),
  };

  return {
    ensureControlPlaneIdentity({ deploymentId = newId('dep'), now }) {
      let identity = queries.identity.get();
      if (!identity) {
        queries.insertIdentity.run(deploymentId, now, now);
        identity = queries.identity.get();
      }
      return identity;
    },
    controlPlaneIdentity: () => queries.identity.get(),
    createControlMigration(values) {
      const id = values.id ?? newId('mig');
      const operationId = values.operationId ?? newId('op');
      queries.insertMigration.run(
        id, values.direction, values.targetUrl ?? null, values.sourceDeploymentId ?? null,
        values.targetDeploymentId ?? null, values.ownershipGeneration, values.status ?? 'draft',
        operationId, JSON.stringify(values.preflight ?? {}), values.requestedBy ?? null, values.now, values.now,
      );
      return queries.migrationById.get(id);
    },
    controlMigrationById: (id) => queries.migrationById.get(id),
    listControlMigrations: (limit = 20) => queries.listMigrations.all(limit),
    updateControlMigration(id, values) {
      const current = queries.migrationById.get(id);
      if (!current) return null;
      const status = values.status ?? current.status;
      const completedAt = values.completedAt ?? (['completed', 'rolled_back', 'cancelled', 'failed'].includes(status) ? values.now : current.completed_at);
      queries.updateMigration.run(
        status, JSON.stringify(values.preflight ?? JSON.parse(current.preflight_json || '{}')),
        values.bundleSha256 ?? current.bundle_sha256, values.targetDeploymentId ?? null,
        values.failureCode ?? null, values.failureMessage ?? null, values.now, completedAt ?? null, id,
      );
      return queries.migrationById.get(id);
    },
    bindControlPlaneMigration(id, status, now) {
      queries.bindMigration.run(id, status, now);
      return queries.identity.get();
    },
    activateControlPlaneIdentity(deploymentId, generation, now) {
      queries.activateIdentity.run(deploymentId, generation, now);
      return queries.identity.get();
    },
  };
}

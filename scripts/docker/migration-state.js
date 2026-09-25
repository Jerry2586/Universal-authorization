import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function required(value, label, pattern = /^.+$/) {
  if (!pattern.test(String(value ?? ''))) throw new Error(`${label} 无效`);
  return String(value);
}

function main() {
  const [action, migrationId, deploymentId, generationText, bundleSha256 = ''] = process.argv.slice(2);
  const databasePath = resolve(process.env.DATABASE_PATH ?? '/app/var/data/appgog.sqlite');
  const database = new DatabaseSync(databasePath);
  const now = new Date().toISOString();
  try {
    const identity = database.prepare("SELECT * FROM control_plane_identity WHERE id = 'primary'").get();
    if (!identity) throw new Error('控制中心身份不存在');
    const id = required(migrationId, '迁移 ID', /^mig_[a-f0-9]{32}$/);
    const migration = database.prepare('SELECT * FROM control_migrations WHERE id = ?').get(id);
    if (action === 'rollback-export-metadata') {
      if (!migration || migration.status !== 'rollback_exporting' || identity.status !== 'fenced') {
        throw new Error('目标服务器尚未进入安全回滚导出状态');
      }
      console.log(JSON.stringify({
        migration_id: id,
        target_deployment_id: identity.deployment_id,
        ownership_generation: identity.ownership_generation,
        status: identity.status,
      }));
      return;
    }
    database.exec('BEGIN IMMEDIATE');
    if (action === 'fence-source') {
      if (!migration) throw new Error('控制中心迁移记录不存在');
      database.prepare("UPDATE control_plane_identity SET status = 'fenced', active_migration_id = ?, updated_at = ? WHERE id = 'primary'").run(id, now);
      database.prepare("UPDATE control_migrations SET status = 'source_read_only', updated_at = ? WHERE id = ?").run(now, id);
    } else if (action === 'activate-target') {
      const target = required(deploymentId, '目标部署 ID', /^dep_[a-f0-9]{32}$/);
      const generation = Number(generationText);
      if (!Number.isSafeInteger(generation) || generation <= identity.ownership_generation) throw new Error('目标所有权代次必须大于源服务器');
      if (bundleSha256 && !/^[a-f0-9]{64}$/.test(bundleSha256)) throw new Error('迁移包摘要无效');
      database.prepare(`UPDATE control_plane_identity SET deployment_id = ?, ownership_generation = ?, status = 'active',
        active_migration_id = NULL, updated_at = ? WHERE id = 'primary'`).run(target, generation, now);
      database.prepare(`UPDATE control_migrations SET status = 'completed', target_deployment_id = ?, bundle_sha256 = ?,
        updated_at = ?, completed_at = ? WHERE id = ?`).run(target, bundleSha256 || null, now, now, id);
    } else if (action === 'rollback-source') {
      if (!migration || migration.status !== 'source_read_only') throw new Error('源服务器不在可恢复的只读迁移状态');
      if (identity.status !== 'fenced' || identity.deployment_id !== migration.source_deployment_id) {
        throw new Error('当前控制中心身份不是该迁移的 Fenced 源实例');
      }
      database.prepare("UPDATE control_plane_identity SET status = 'active', active_migration_id = NULL, updated_at = ? WHERE id = 'primary'").run(now);
      database.prepare("UPDATE control_migrations SET status = 'rolled_back', updated_at = ?, completed_at = ? WHERE id = ?").run(now, now, id);
    } else if (action === 'prepare-rollback-export') {
      if (!migration || migration.status !== 'completed') throw new Error('只有已完成的迁移才能导出最终回滚数据');
      if (identity.status !== 'active' || identity.deployment_id !== migration.target_deployment_id) {
        throw new Error('当前服务器不是该迁移的 Active 目标实例');
      }
      database.prepare("UPDATE control_plane_identity SET status = 'fenced', active_migration_id = ?, updated_at = ? WHERE id = 'primary'").run(id, now);
      database.prepare("UPDATE control_migrations SET status = 'rollback_exporting', updated_at = ? WHERE id = ?").run(now, id);
    } else if (action === 'cancel-rollback-export') {
      if (!migration || migration.status !== 'rollback_exporting') throw new Error('没有正在导出的回滚任务');
      database.prepare("UPDATE control_plane_identity SET status = 'active', active_migration_id = NULL, updated_at = ? WHERE id = 'primary'").run(now);
      database.prepare("UPDATE control_migrations SET status = 'completed', updated_at = ? WHERE id = ?").run(now, id);
    } else if (action === 'activate-source-rollback') {
      const source = required(deploymentId, '源部署 ID', /^dep_[a-f0-9]{32}$/);
      const generation = Number(generationText);
      if (!migration || migration.status !== 'rollback_exporting') throw new Error('回滚数据未由目标服务器安全导出');
      if (identity.status !== 'fenced') throw new Error('导入的目标快照没有 Fenced，拒绝恢复为源服务器');
      if (identity.deployment_id !== migration.target_deployment_id) throw new Error('导入快照的目标部署身份不匹配');
      if (!Number.isSafeInteger(generation) || generation <= identity.ownership_generation) throw new Error('回滚所有权代次必须高于目标服务器');
      if (!/^[a-f0-9]{64}$/.test(bundleSha256)) throw new Error('回滚包摘要无效');
      database.prepare(`UPDATE control_plane_identity SET deployment_id = ?, ownership_generation = ?, status = 'active',
        active_migration_id = NULL, updated_at = ? WHERE id = 'primary'`).run(source, generation, now);
      database.prepare(`UPDATE control_migrations SET status = 'rolled_back', bundle_sha256 = ?, updated_at = ?, completed_at = ?
        WHERE id = ?`).run(bundleSha256, now, now, id);
    } else {
      throw new Error('迁移状态动作无效');
    }
    database.prepare(`INSERT INTO audit_events (
      id, actor_type, actor_id, action, subject_type, subject_id, metadata_json, created_at
    ) VALUES (?, 'system', NULL, ?, 'control_migration', ?, ?, ?)`)
      .run(`aud_${randomUUID().replaceAll('-', '')}`, `control_migration.${action}`, id,
        JSON.stringify({ deployment_id: deploymentId || null, ownership_generation: generationText || null, bundle_sha256: bundleSha256 || null }), now);
    database.exec('COMMIT');
    console.log(`控制中心迁移状态已更新：${action}`);
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw error;
  } finally {
    database.close();
  }
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }

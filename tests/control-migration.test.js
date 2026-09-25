import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase } from '../apps/license-api/src/database.js';
import { createRepository } from '../apps/license-api/src/repository.js';
import { createMigrationControl } from '../apps/license-api/src/migration-control.js';
import { createControlMigrationRepository } from '../apps/license-api/src/modules/migration/repository.js';

const migrationStateScript = join(import.meta.dirname, '..', 'scripts', 'docker', 'migration-state.js');

function fixture(t, label) {
  const root = mkdtempSync(join(tmpdir(), `appgog-migration-${label}-`));
  const database = openDatabase(':memory:');
  createRepository(database);
  const repository = createControlMigrationRepository(database);
  let now = new Date('2026-09-24T08:00:00.000Z');
  const config = {
    pepper: `${label}-migration-pepper-that-is-longer-than-thirty-two`,
    sessionSecret: `${label}-migration-session-secret-longer-than-thirty-two`,
    publicBaseUrl: `https://${label}.example.com`,
    updateControlPath: root,
    packageVersion: '1.2.10',
  };
  const control = createMigrationControl({ repository, config, root, clock: () => new Date(now) });
  t.after(() => { database.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, database, repository, config, control, advance(ms) { now = new Date(now.getTime() + ms); } };
}

function uploadStream(body) {
  const stream = Readable.from([body]);
  stream.headers = { 'content-length': String(body.length) };
  return stream;
}

function sha256(body) {
  return createHash('sha256').update(body).digest('hex');
}

function stateFixture(t, label) {
  const root = mkdtempSync(join(tmpdir(), `appgog-migration-state-${label}-`));
  const databasePath = join(root, 'appgog.sqlite');
  const migrationId = `mig_${createHash('sha256').update(label).digest('hex').slice(0, 32)}`;
  const sourceDeploymentId = `dep_${'1'.repeat(32)}`;
  const targetDeploymentId = `dep_${'2'.repeat(32)}`;
  const database = openDatabase(databasePath);
  const repository = createControlMigrationRepository(database);
  const now = '2026-09-25T08:00:00.000Z';
  repository.ensureControlPlaneIdentity({ deploymentId: sourceDeploymentId, now });
  repository.createControlMigration({
    id: migrationId,
    direction: 'source_to_target',
    sourceDeploymentId,
    targetDeploymentId,
    ownershipGeneration: 2,
    status: 'completed',
    now,
  });
  database.prepare(`UPDATE control_plane_identity SET deployment_id = ?, ownership_generation = 2,
    status = 'active', active_migration_id = NULL WHERE id = 'primary'`).run(targetDeploymentId);
  database.close();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { databasePath, migrationId, sourceDeploymentId, targetDeploymentId };
}

function runMigrationState(fixture, ...args) {
  return spawnSync(process.execPath, [migrationStateScript, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_PATH: fixture.databasePath },
  });
}

function readMigrationState(fixture) {
  const database = openDatabase(fixture.databasePath);
  try {
    return {
      identity: database.prepare("SELECT * FROM control_plane_identity WHERE id = 'primary'").get(),
      migration: database.prepare('SELECT * FROM control_migrations WHERE id = ?').get(fixture.migrationId),
    };
  } finally {
    database.close();
  }
}

test('控制中心迁移使用一次性配对、固定收件箱和宿主机受控请求', async (t) => {
  const target = fixture(t, 'target');
  const source = fixture(t, 'source');
  const opened = target.control.openReceiver('owner-target');
  assert.match(opened.pairing_code, /^MIG-[A-Z2-9]{6}-[A-Z2-9]{6}$/);

  const queued = source.control.beginSource({
    targetUrl: opened.target_url, pairingCode: opened.pairing_code, actorId: 'owner-source',
  });
  assert.equal(queued.status, 'queued');
  assert.equal(source.repository.controlPlaneIdentity().status, 'active');
  assert.equal(source.repository.controlPlaneIdentity().active_migration_id, queued.id);
  const requestFile = readdirSync(join(source.root, 'requests')).find((name) => name.endsWith('.json'));
  const request = JSON.parse(readFileSync(join(source.root, 'requests', requestFile), 'utf8'));
  assert.equal(request.action, 'transfer-source');
  assert.equal(request.target_url, 'https://target.example.com');

  assert.throws(() => target.control.handshake({
    pairingCode: 'MIG-AAAAAA-BBBBBB', migrationId: queued.id,
    sourceDeploymentId: source.repository.controlPlaneIdentity().deployment_id,
    sourceVersion: '1.2.10', ownershipGeneration: queued.ownership_generation,
  }), (error) => error.code === 'MIGRATION_PAIRING_CODE_INVALID');

  const handshake = target.control.handshake({
    pairingCode: opened.pairing_code, migrationId: queued.id,
    sourceDeploymentId: source.repository.controlPlaneIdentity().deployment_id,
    sourceVersion: '1.2.10', ownershipGeneration: queued.ownership_generation,
  });
  assert.equal(handshake.target_version, '1.2.10');
  assert.match(handshake.upload_token, /^MUP_/);
  assert.throws(() => target.control.handshake({
    pairingCode: opened.pairing_code, migrationId: queued.id,
    sourceDeploymentId: request.source_deployment_id,
    sourceVersion: '1.2.10', ownershipGeneration: queued.ownership_generation,
  }), (error) => error.code === 'MIGRATION_RECEIVER_UNAVAILABLE');

  const body = Buffer.from('encrypted-migration-bundle');
  const stream = Readable.from([body]);
  stream.headers = { 'content-length': String(body.length) };
  const accepted = await target.control.receiveBundle({
    request: stream, id: handshake.session_id, token: handshake.upload_token,
    backupKey: 'A'.repeat(48),
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.bytes, body.length);
  const targetRequests = readdirSync(join(target.root, 'requests')).map((name) => JSON.parse(readFileSync(join(target.root, 'requests', name), 'utf8')));
  const importRequest = targetRequests.find((item) => item.action === 'import-target');
  assert.ok(importRequest);
  assert.equal(importRequest.migration_id, queued.id);
  assert.match(importRequest.bundle_path, /migration[\\/]inbox[\\/].+\.tar\.gz\.enc$/);
  assert.match(importRequest.backup_key_path, /migration[\\/]inbox[\\/].+\.backup-key$/);
  assert.equal(target.control.publicStatus(handshake.session_id, handshake.upload_token).state, 'import_queued');
});

test('迁移配对码和上传会话按时过期，且目标地址强制 HTTPS', async (t) => {
  const target = fixture(t, 'expiry-target');
  const source = fixture(t, 'expiry-source');
  assert.throws(() => source.control.beginSource({
    targetUrl: 'http://remote.example.com', pairingCode: 'MIG-AAAAAA-BBBBBB', actorId: 'owner',
  }), (error) => error.code === 'MIGRATION_TARGET_TLS_REQUIRED');
  const opened = target.control.openReceiver('owner');
  target.advance(16 * 60 * 1000);
  assert.throws(() => target.control.handshake({
    pairingCode: opened.pairing_code, migrationId: 'mig_1234567890abcdef1234567890abcdef',
    sourceDeploymentId: 'dep_1234567890abcdef1234567890abcdef', sourceVersion: '1.2.10', ownershipGeneration: 2,
  }), (error) => error.code === 'MIGRATION_RECEIVER_UNAVAILABLE');
});

test('迁移分块逐块校验、支持固定序号重传，并在整包校验后才排队恢复', async (t) => {
  const target = fixture(t, 'chunk-target');
  const opened = target.control.openReceiver('owner-target');
  const handshake = target.control.handshake({
    pairingCode: opened.pairing_code,
    migrationId: 'mig_1234567890abcdef1234567890abcdef',
    sourceDeploymentId: 'dep_1234567890abcdef1234567890abcdef',
    sourceVersion: '1.2.10',
    ownershipGeneration: 2,
  });
  const firstDraft = Buffer.from('first-draft-');
  const first = Buffer.from('first-final-');
  const second = Buffer.from('second-final');

  await assert.rejects(target.control.receiveChunk({
    request: uploadStream(firstDraft), id: handshake.session_id, token: handshake.upload_token,
    index: 0, totalChunks: 2, expectedSha256: '0'.repeat(64),
  }), (error) => error.code === 'MIGRATION_CHUNK_DIGEST_MISMATCH');

  await target.control.receiveChunk({
    request: uploadStream(firstDraft), id: handshake.session_id, token: handshake.upload_token,
    index: 0, totalChunks: 2, expectedSha256: sha256(firstDraft),
  });
  const retransmitted = await target.control.receiveChunk({
    request: uploadStream(first), id: handshake.session_id, token: handshake.upload_token,
    index: 0, totalChunks: 2, expectedSha256: sha256(first),
  });
  assert.equal(retransmitted.received_chunks, 1);

  assert.throws(() => target.control.completeChunks({
    id: handshake.session_id, token: handshake.upload_token, totalChunks: 2,
    totalSha256: sha256(Buffer.concat([first, second])), backupKey: 'B'.repeat(48),
  }), (error) => error.code === 'MIGRATION_CHUNK_MISSING');
  assert.equal(readdirSync(join(target.root, 'requests')).length, 0);

  await target.control.receiveChunk({
    request: uploadStream(second), id: handshake.session_id, token: handshake.upload_token,
    index: 1, totalChunks: 2, expectedSha256: sha256(second),
  });
  assert.throws(() => target.control.completeChunks({
    id: handshake.session_id, token: handshake.upload_token, totalChunks: 2,
    totalSha256: 'f'.repeat(64), backupKey: 'B'.repeat(48),
  }), (error) => error.code === 'MIGRATION_BUNDLE_DIGEST_MISMATCH');
  assert.equal(readdirSync(join(target.root, 'requests')).length, 0);

  const accepted = target.control.completeChunks({
    id: handshake.session_id, token: handshake.upload_token, totalChunks: 2,
    totalSha256: sha256(Buffer.concat([first, second])), backupKey: 'B'.repeat(48),
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.bytes, first.length + second.length);
  const requests = readdirSync(join(target.root, 'requests'))
    .map((name) => JSON.parse(readFileSync(join(target.root, 'requests', name), 'utf8')));
  assert.equal(requests.filter((item) => item.action === 'import-target').length, 1);
  assert.equal(target.control.publicStatus(handshake.session_id, handshake.upload_token).state, 'import_queued');
});

test('控制中心安全回滚导出只允许当前 Active 目标并立即 Fenced', (t) => {
  const fixture = stateFixture(t, 'rollback-export');
  const prepared = runMigrationState(fixture, 'prepare-rollback-export', fixture.migrationId);
  assert.equal(prepared.status, 0, prepared.stderr);
  let state = readMigrationState(fixture);
  assert.equal(state.identity.status, 'fenced');
  assert.equal(state.identity.active_migration_id, fixture.migrationId);
  assert.equal(state.migration.status, 'rollback_exporting');

  const metadata = runMigrationState(fixture, 'rollback-export-metadata', fixture.migrationId);
  assert.equal(metadata.status, 0, metadata.stderr);
  assert.deepEqual(JSON.parse(metadata.stdout), {
    migration_id: fixture.migrationId,
    target_deployment_id: fixture.targetDeploymentId,
    ownership_generation: 2,
    status: 'fenced',
  });

  const repeated = runMigrationState(fixture, 'prepare-rollback-export', fixture.migrationId);
  assert.notEqual(repeated.status, 0);
  assert.match(repeated.stderr, /只有已完成的迁移才能导出/);
});

test('控制中心回滚导出失败可恢复目标 Active', (t) => {
  const fixture = stateFixture(t, 'rollback-cancel');
  assert.equal(runMigrationState(fixture, 'prepare-rollback-export', fixture.migrationId).status, 0);
  const cancelled = runMigrationState(fixture, 'cancel-rollback-export', fixture.migrationId);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  const state = readMigrationState(fixture);
  assert.equal(state.identity.status, 'active');
  assert.equal(state.identity.deployment_id, fixture.targetDeploymentId);
  assert.equal(state.identity.active_migration_id, null);
  assert.equal(state.migration.status, 'completed');
});

test('旧源回滚必须导入 Fenced 目标快照并使用更高所有权代次', (t) => {
  const digest = 'a'.repeat(64);
  const fixture = stateFixture(t, 'rollback-activate-source');
  assert.equal(runMigrationState(fixture, 'prepare-rollback-export', fixture.migrationId).status, 0);

  const stale = runMigrationState(fixture, 'activate-source-rollback', fixture.migrationId, fixture.sourceDeploymentId, '2', digest);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /回滚所有权代次必须高于目标服务器/);

  const activated = runMigrationState(fixture, 'activate-source-rollback', fixture.migrationId, fixture.sourceDeploymentId, '3', digest);
  assert.equal(activated.status, 0, activated.stderr);
  const state = readMigrationState(fixture);
  assert.equal(state.identity.status, 'active');
  assert.equal(state.identity.deployment_id, fixture.sourceDeploymentId);
  assert.equal(state.identity.ownership_generation, 3);
  assert.equal(state.migration.status, 'rolled_back');
  assert.equal(state.migration.bundle_sha256, digest);
});

test('非 Fenced 目标快照不能激活旧源', (t) => {
  const fixture = stateFixture(t, 'rollback-reject-active');
  const database = openDatabase(fixture.databasePath);
  database.prepare("UPDATE control_migrations SET status = 'rollback_exporting' WHERE id = ?").run(fixture.migrationId);
  database.close();
  const result = runMigrationState(fixture, 'activate-source-rollback', fixture.migrationId, fixture.sourceDeploymentId, '3', 'b'.repeat(64));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /没有 Fenced/);
  assert.equal(readMigrationState(fixture).identity.deployment_id, fixture.targetDeploymentId);
});

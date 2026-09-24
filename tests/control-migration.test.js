import assert from 'node:assert/strict';
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

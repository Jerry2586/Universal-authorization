import {
  createHash, randomBytes, timingSafeEqual,
} from 'node:crypto';
import {
  createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DomainError, invariant } from '../../../../../packages/core/src/errors.js';
import { newId } from '../../../../../packages/core/src/identifiers.js';
import { hashSecret } from '../../../../../packages/core/src/security.js';

const PAIR_TTL_MS = 15 * 60 * 1000;
const UPLOAD_TTL_MS = 30 * 60 * 1000;
const MAX_BUNDLE_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_CHUNK_BYTES = 70 * 1024 * 1024;
const MAX_CHUNKS = 100_000;
const PAIRING_PATTERN = /^MIG-[A-Z2-9]{6}-[A-Z2-9]{6}$/;
const BACKUP_KEY_PATTERN = /^[A-Za-z0-9+/=_-]{32,256}$/;

function readJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function safeEqual(left, right) {
  const a = Buffer.from(left ?? '');
  const b = Buffer.from(right ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}

function pairingCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(12);
  const text = [...bytes].map((value) => alphabet[value % alphabet.length]).join('');
  return `MIG-${text.slice(0, 6)}-${text.slice(6)}`;
}

function normalizedTargetUrl(value, production) {
  let url;
  try { url = new URL(String(value ?? '').trim()); } catch { throw new DomainError('MIGRATION_TARGET_INVALID', '目标服务器地址无效', 400); }
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  invariant(url.protocol === 'https:' || (!production && local && url.protocol === 'http:'),
    'MIGRATION_TARGET_TLS_REQUIRED', '目标服务器必须使用 HTTPS；仅本地开发允许 HTTP', 400);
  invariant(!url.username && !url.password && !url.search && !url.hash,
    'MIGRATION_TARGET_INVALID', '目标服务器地址不能包含账号、查询参数或片段', 400);
  return url.origin;
}

export function createMigrationControl({ repository, audit = () => {}, config, root, clock = () => new Date() }) {
  root = resolve(root ?? config.updateControlPath ?? './var/update-control', 'migration');
  const requestRoot = resolve(root, '..', 'requests');
  const inboxRoot = join(root, 'inbox');
  const receiverPath = join(root, 'receiver.json');
  const helperStatusPath = join(root, 'status.json');
  mkdirSync(requestRoot, { recursive: true });
  mkdirSync(inboxRoot, { recursive: true });
  const identity = repository.ensureControlPlaneIdentity({ now: clock().toISOString() });

  function receiver() {
    const value = readJson(receiverPath);
    if (!value) return null;
    if (new Date(value.expires_at) <= clock()) return { ...value, state: 'expired' };
    return value;
  }

  function requireUploadSession(token, id) {
    const current = receiver();
    invariant(current && current.id === id && ['paired', 'uploading'].includes(current.state),
      'MIGRATION_SESSION_INVALID', '迁移接收会话无效', 401);
    invariant(new Date(current.upload_expires_at) > clock(), 'MIGRATION_SESSION_EXPIRED', '迁移上传会话已过期', 401);
    invariant(safeEqual(hashSecret(token, config.sessionSecret), current.upload_token_hash),
      'MIGRATION_UPLOAD_UNAUTHORIZED', '迁移上传凭证无效', 401);
    return current;
  }

  function queueImport(current, id, backupKey, sha256, size, finalPath) {
    invariant(BACKUP_KEY_PATTERN.test(String(backupKey ?? '')), 'MIGRATION_BACKUP_KEY_INVALID', '迁移备份恢复密钥格式无效', 400);
    const keyPath = join(inboxRoot, `${id}.backup-key`);
    writeFileSync(keyPath, `${backupKey}\n`, { mode: 0o600 });
    const requestDocument = {
      id: newId('op'), action: 'import-target', session_id: id,
      bundle_path: finalPath, backup_key_path: keyPath, bundle_sha256: sha256,
      source_deployment_id: current.source_deployment_id,
      target_deployment_id: current.target_deployment_id,
      migration_id: current.migration_id,
      ownership_generation: current.ownership_generation,
      requested_at: clock().toISOString(),
    };
    const allowedRoot = `${root}${sep}`;
    invariant(`${resolve(finalPath)}`.startsWith(allowedRoot) && `${resolve(keyPath)}`.startsWith(allowedRoot),
      'MIGRATION_PATH_INVALID', '迁移存储路径越界', 500);
    atomicJson(join(requestRoot, `${requestDocument.id}.json`), requestDocument);
    atomicJson(receiverPath, { ...current, state: 'import_queued', bundle_sha256: sha256, bundle_bytes: size, updated_at: clock().toISOString() });
    return { accepted: true, session_id: id, sha256, bytes: size };
  }

  return {
    status() {
      const currentReceiver = receiver();
      const helper = readJson(helperStatusPath);
      return {
        identity: repository.controlPlaneIdentity(),
        receiver: currentReceiver ? {
          id: currentReceiver.id, state: currentReceiver.state, expires_at: currentReceiver.expires_at,
          source_version: currentReceiver.source_version ?? null, source_deployment_id: currentReceiver.source_deployment_id ?? null,
        } : null,
        operation: helper,
        history: repository.listControlMigrations(20),
      };
    },

    openReceiver(actorId) {
      const active = receiver();
      invariant(!active || ['expired', 'completed', 'failed', 'cancelled'].includes(active.state),
        'MIGRATION_RECEIVER_ACTIVE', '已有迁移接收会话正在进行', 409);
      const code = pairingCode();
      const now = clock();
      const session = {
        schema: 1, id: newId('mgr'), state: 'waiting_pair',
        pairing_hash: hashSecret(code, config.pepper),
        target_deployment_id: identity.deployment_id,
        target_version: config.packageVersion ?? null,
        created_by: actorId, created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + PAIR_TTL_MS).toISOString(),
      };
      atomicJson(receiverPath, session);
      audit({
        actorType: 'admin', actorId, action: 'control_migration.receiver_opened',
        subjectType: 'control_migration', subjectId: session.id,
        metadata: { expires_at: session.expires_at }, now: now.toISOString(),
      });
      return { id: session.id, pairing_code: code, expires_at: session.expires_at, target_url: config.publicBaseUrl };
    },

    closeReceiver(actorId) {
      const current = receiver();
      if (!current) return { closed: true };
      const now = clock().toISOString();
      atomicJson(receiverPath, { ...current, state: 'cancelled', cancelled_by: actorId, updated_at: now });
      audit({
        actorType: 'admin', actorId, action: 'control_migration.receiver_closed',
        subjectType: 'control_migration', subjectId: current.id, now,
      });
      return { closed: true };
    },

    beginSource({ targetUrl, pairingCode: code, actorId }) {
      const normalized = normalizedTargetUrl(targetUrl, process.env.NODE_ENV === 'production');
      invariant(PAIRING_PATTERN.test(String(code ?? '').trim().toUpperCase()), 'MIGRATION_PAIRING_CODE_INVALID', '迁移配对码格式无效');
      const currentIdentity = repository.controlPlaneIdentity();
      invariant(currentIdentity?.status === 'active' && !currentIdentity.active_migration_id,
        'MIGRATION_ALREADY_ACTIVE', '当前控制中心已有迁移任务', 409);
      const now = clock().toISOString();
      const migration = repository.createControlMigration({
        direction: 'source', targetUrl: normalized, sourceDeploymentId: currentIdentity.deployment_id,
        ownershipGeneration: currentIdentity.ownership_generation + 1, status: 'queued', requestedBy: actorId, now,
      });
      // Keep serving until the host helper has completed preflight. The helper
      // moves the source to fenced state immediately before the final snapshot.
      repository.bindControlPlaneMigration(migration.id, 'active', now);
      const request = {
        id: migration.operation_id, action: 'transfer-source', migration_id: migration.id,
        target_url: normalized, pairing_code: String(code).trim().toUpperCase(),
        source_deployment_id: currentIdentity.deployment_id,
        ownership_generation: migration.ownership_generation,
        requested_at: now,
      };
      atomicJson(join(requestRoot, `${request.id}.json`), request);
      audit({
        actorType: 'admin', actorId, action: 'control_migration.source_queued',
        subjectType: 'control_migration', subjectId: migration.id,
        metadata: { target_url: normalized, operation_id: migration.operation_id }, now,
      });
      return migration;
    },

    handshake({ pairingCode: code, migrationId, sourceDeploymentId, sourceVersion, ownershipGeneration }) {
      const current = receiver();
      invariant(current && current.state === 'waiting_pair', 'MIGRATION_RECEIVER_UNAVAILABLE', '目标服务器未开启迁移接收或会话已失效', 409);
      invariant(PAIRING_PATTERN.test(String(code ?? '').trim().toUpperCase()), 'MIGRATION_PAIRING_CODE_INVALID', '迁移配对码格式无效');
      invariant(safeEqual(hashSecret(String(code).trim().toUpperCase(), config.pepper), current.pairing_hash),
        'MIGRATION_PAIRING_CODE_INVALID', '迁移配对码无效', 401);
      invariant(typeof sourceDeploymentId === 'string' && sourceDeploymentId.startsWith('dep_'), 'MIGRATION_SOURCE_ID_INVALID', '源服务器身份无效');
      invariant(/^mig_[a-f0-9]{32}$/.test(String(migrationId ?? '')), 'MIGRATION_ID_INVALID', '迁移任务 ID 无效');
      invariant(Number.isSafeInteger(ownershipGeneration) && ownershipGeneration >= 2, 'MIGRATION_GENERATION_INVALID', '迁移所有权代次无效');
      const token = `MUP_${randomBytes(36).toString('base64url')}`;
      const now = clock();
      const paired = {
        ...current, state: 'paired', pairing_hash: null,
        migration_id: migrationId, source_deployment_id: sourceDeploymentId, source_version: sourceVersion ?? null,
        ownership_generation: ownershipGeneration,
        upload_token_hash: hashSecret(token, config.sessionSecret),
        upload_expires_at: new Date(now.getTime() + UPLOAD_TTL_MS).toISOString(), updated_at: now.toISOString(),
      };
      atomicJson(receiverPath, paired);
      return {
        session_id: paired.id, upload_token: token, upload_expires_at: paired.upload_expires_at,
        target_deployment_id: paired.target_deployment_id, target_version: paired.target_version,
        architecture: process.arch, platform: process.platform, server_time: now.toISOString(),
      };
    },

    publicStatus(id, token) {
      const current = receiver();
      invariant(current && current.id === id, 'MIGRATION_SESSION_INVALID', '迁移接收会话不存在', 404);
      invariant(safeEqual(hashSecret(token, config.sessionSecret), current.upload_token_hash),
        'MIGRATION_UPLOAD_UNAUTHORIZED', '迁移上传凭证无效', 401);
      const helper = readJson(helperStatusPath);
      return { id: current.id, state: helper?.session_id === id ? helper.state : current.state, message: helper?.message ?? null,
        target_deployment_id: current.target_deployment_id, ownership_generation: current.ownership_generation };
    },

    async receiveBundle({ request, id, token, backupKey }) {
      const current = requireUploadSession(token, id);
      const announced = Number(request.headers['content-length'] ?? 0);
      invariant(!announced || announced <= MAX_BUNDLE_BYTES, 'MIGRATION_BUNDLE_TOO_LARGE', '迁移包超出上限', 413);
      const finalPath = join(inboxRoot, `${id}.tar.gz.enc`);
      const temporary = `${finalPath}.${process.pid}.partial`;
      const digest = createHash('sha256');
      let size = 0;
      const limiter = new Transform({ transform(chunk, encoding, callback) {
        size += chunk.length;
        if (size > MAX_BUNDLE_BYTES) return callback(new DomainError('MIGRATION_BUNDLE_TOO_LARGE', '迁移包超出上限', 413));
        digest.update(chunk);
        callback(null, chunk);
      } });
      try {
        await pipeline(request, limiter, createWriteStream(temporary, { mode: 0o600 }));
        invariant(size > 0, 'MIGRATION_BUNDLE_EMPTY', '迁移包为空', 400);
        renameSync(temporary, finalPath);
      } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
      }
      const sha256 = digest.digest('hex');
      return queueImport(current, id, backupKey, sha256, size, finalPath);
    },

    async receiveChunk({ request, id, token, index, totalChunks, expectedSha256 }) {
      const current = requireUploadSession(token, id);
      invariant(Number.isSafeInteger(index) && index >= 0 && index < MAX_CHUNKS, 'MIGRATION_CHUNK_INDEX_INVALID', '迁移分块序号无效');
      invariant(Number.isSafeInteger(totalChunks) && totalChunks > 0 && totalChunks <= MAX_CHUNKS && index < totalChunks,
        'MIGRATION_CHUNK_COUNT_INVALID', '迁移分块总数无效');
      invariant(current.total_chunks === undefined || current.total_chunks === totalChunks,
        'MIGRATION_CHUNK_COUNT_MISMATCH', '迁移分块总数与当前会话不一致', 409);
      invariant(/^[a-f0-9]{64}$/.test(String(expectedSha256 ?? '')), 'MIGRATION_CHUNK_DIGEST_INVALID', '迁移分块摘要无效');
      const announced = Number(request.headers['content-length'] ?? 0);
      invariant(!announced || announced <= MAX_CHUNK_BYTES, 'MIGRATION_CHUNK_TOO_LARGE', '迁移分块超出 70 MiB 上限', 413);
      const chunkRoot = join(inboxRoot, `${id}-chunks`);
      mkdirSync(chunkRoot, { recursive: true });
      const chunkName = `${String(index).padStart(6, '0')}.chunk`;
      const finalPath = join(chunkRoot, chunkName);
      const temporary = `${finalPath}.${process.pid}.partial`;
      const digest = createHash('sha256');
      let size = 0;
      const limiter = new Transform({ transform(chunk, encoding, callback) {
        size += chunk.length;
        if (size > MAX_CHUNK_BYTES) return callback(new DomainError('MIGRATION_CHUNK_TOO_LARGE', '迁移分块超出 70 MiB 上限', 413));
        digest.update(chunk);
        callback(null, chunk);
      } });
      try {
        await pipeline(request, limiter, createWriteStream(temporary, { mode: 0o600 }));
        invariant(size > 0, 'MIGRATION_CHUNK_EMPTY', '迁移分块为空');
        const actual = digest.digest('hex');
        invariant(actual === expectedSha256, 'MIGRATION_CHUNK_DIGEST_MISMATCH', '迁移分块 SHA-256 校验失败', 409);
        rmSync(finalPath, { force: true });
        renameSync(temporary, finalPath);
      } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
      }
      const received = readdirSync(chunkRoot).filter((name) => /^\d{6}\.chunk$/.test(name)).length;
      atomicJson(receiverPath, { ...current, state: 'uploading', total_chunks: totalChunks, received_chunks: received, updated_at: clock().toISOString() });
      return { accepted: true, index, bytes: size, received_chunks: received, total_chunks: totalChunks };
    },

    completeChunks({ id, token, totalChunks, totalSha256, backupKey }) {
      const current = requireUploadSession(token, id);
      invariant(Number.isSafeInteger(totalChunks) && totalChunks > 0 && totalChunks <= MAX_CHUNKS,
        'MIGRATION_CHUNK_COUNT_INVALID', '迁移分块总数无效');
      invariant(current.total_chunks === undefined || current.total_chunks === totalChunks,
        'MIGRATION_CHUNK_COUNT_MISMATCH', '迁移分块总数与当前会话不一致', 409);
      invariant(/^[a-f0-9]{64}$/.test(String(totalSha256 ?? '')), 'MIGRATION_BUNDLE_DIGEST_INVALID', '迁移包摘要无效');
      const chunkRoot = join(inboxRoot, `${id}-chunks`);
      const finalPath = join(inboxRoot, `${id}.tar.gz.enc`);
      const temporary = `${finalPath}.${process.pid}.partial`;
      const digest = createHash('sha256');
      let size = 0;
      try {
        rmSync(temporary, { force: true });
        for (let index = 0; index < totalChunks; index += 1) {
          const chunkPath = join(chunkRoot, `${String(index).padStart(6, '0')}.chunk`);
          invariant(existsSync(chunkPath), 'MIGRATION_CHUNK_MISSING', `迁移分块 ${index + 1}/${totalChunks} 缺失`, 409);
          const chunk = readFileSync(chunkPath);
          size += chunk.length;
          invariant(size <= MAX_BUNDLE_BYTES, 'MIGRATION_BUNDLE_TOO_LARGE', '迁移包超出上限', 413);
          digest.update(chunk);
          writeFileSync(temporary, chunk, { flag: 'a', mode: 0o600 });
        }
        const actual = digest.digest('hex');
        invariant(actual === totalSha256, 'MIGRATION_BUNDLE_DIGEST_MISMATCH', '迁移包最终 SHA-256 校验失败', 409);
        renameSync(temporary, finalPath);
        rmSync(chunkRoot, { recursive: true, force: true });
        return queueImport(current, id, backupKey, actual, size, finalPath);
      } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
      }
    },
  };
}

import type { PoolClient } from 'pg';
import type { PostgresDatabase } from '../../../infrastructure/database/postgres-database.js';
import { AppError } from '../../../shared/errors/app-error.js';
import { compareVersions } from '../../../shared/version.js';
import { assertSelfUnbindPolicy } from '../../devices/device-unbind.policy.js';
import type {
  DeviceRequestIdentity,
  DeviceRequestIdentityInput,
  DeviceUnbindRuntimeResult,
  HeartbeatRuntimeLicenseInput,
  LicenseRuntimeRepository,
  RefreshRuntimeLicenseInput,
  RuntimeFeature,
  RuntimeLicenseGrant,
  RuntimeLicenseInput,
  SessionReleaseRuntimeResult,
} from '../license-runtime.repository.js';

interface RuntimeRow {
  tenant_id: string;
  tenant_status: string;
  product_id: string;
  product_code: string;
  product_status: string;
  minimum_client_version: string | null;
  force_update_version: string | null;
  client_version_status: string | null;
  client_version_force_update: boolean | null;
  license_id: string;
  license_status: string;
  license_type: string;
  license_starts_at: Date | null;
  license_expires_at: Date | null;
  max_devices: number;
  max_concurrent_sessions: number;
  offline_grace_seconds: number;
  allow_self_unbind: boolean;
  unbind_cooldown_seconds: number;
  device_id: string;
  device_status: string;
  device_public_key: string;
  device_public_key_fingerprint: string;
  fingerprint_hash: string;
  activation_id: string;
  activation_status: string;
  activation_activated_at: Date;
  device_key_id: string | null;
  session_id: string;
  token_jti: string;
  session_status: string;
  session_issued_at: Date;
  session_expires_at: Date;
  session_offline_until: Date | null;
}

interface FeatureRow {
  code: string;
  allowed: boolean;
  limits: Readonly<Record<string, unknown>>;
  expires_at: Date | null;
}

export class PostgresLicenseRuntimeRepository implements LicenseRuntimeRepository {
  public constructor(private readonly database: PostgresDatabase) {}

  public async loadDeviceRequestIdentity(input: DeviceRequestIdentityInput): Promise<DeviceRequestIdentity> {
    const result = await this.database.query<{
      device_public_key: string;
      device_public_key_fingerprint: string;
      device_key_id: string | null;
    }>(
      `SELECT d.device_public_key, d.device_public_key_fingerprint,
              a.metadata->>'device_key_id' AS device_key_id
         FROM activations a
         JOIN devices d ON d.id = a.device_id
         JOIN license_keys lk ON lk.id = a.license_key_id
         JOIN products p ON p.id = lk.product_id
        WHERE a.tenant_id = $1 AND p.code = $2 AND lk.id = $3
          AND d.id = $4 AND a.id = $5
        LIMIT 1`,
      [input.tenantId, input.productCode, input.licenseId, input.deviceId, input.activationId],
    );
    const row = result.rows[0];
    if (row === undefined || row.device_key_id === null) {
      throw businessError('DEVICE_CREDENTIAL_INVALID', '服务器找不到与设备凭证匹配的登记信息', 401);
    }
    return {
      publicKeyPem: row.device_public_key,
      publicKeyFingerprint: row.device_public_key_fingerprint,
      deviceKeyId: row.device_key_id,
    };
  }

  public async verify(input: RuntimeLicenseInput): Promise<RuntimeLicenseGrant> {
    return this.database.transaction(async (client) => {
      const row = await this.loadRuntimeRow(client, input, false);
      await this.validateRuntime(client, row, input);
      const features = await this.loadFeatures(client, row.license_id, input.now);
      await client.query('UPDATE activations SET last_verified_at = $2 WHERE id = $1', [row.activation_id, input.now]);
      await client.query('UPDATE devices SET last_seen_at = $2 WHERE id = $1', [row.device_id, input.now]);
      await this.insertEvent(client, row, row.session_id, 'LICENSE_VERIFIED', input);
      return this.toGrant(row, features);
    });
  }

  public async refresh(input: RefreshRuntimeLicenseInput): Promise<RuntimeLicenseGrant> {
    return this.database.transaction(async (client) => {
      const row = await this.loadRuntimeRow(client, input, true);
      await this.validateRuntime(client, row, input);

      await client.query(
        `UPDATE license_sessions SET status = 'REVOKED', revoked_at = $2
          WHERE id = $1 AND status IN ('VALID', 'GRACE')`,
        [row.session_id, input.now],
      );
      const activeSessions = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM license_sessions
          WHERE license_key_id = $1 AND status IN ('VALID', 'GRACE') AND expires_at > $2`,
        [row.license_id, input.now],
      );
      if (Number(activeSessions.rows[0]?.count ?? 0) >= row.max_concurrent_sessions) {
        throw businessError('LICENSE_CONCURRENCY_LIMIT_REACHED', '授权同时在线数量已达到上限', 409);
      }

      const tokenExpiresAt = minDate(new Date(input.now.getTime() + input.tokenTtlSeconds * 1_000), row.license_expires_at);
      if (tokenExpiresAt.getTime() <= input.now.getTime()) throw businessError('LICENSE_EXPIRED', '授权已到期', 403);
      const offlineUntil = minNullableDate(
        new Date(tokenExpiresAt.getTime() + row.offline_grace_seconds * 1_000),
        row.license_expires_at,
      );

      await client.query(
        `INSERT INTO license_sessions (
           id, tenant_id, license_key_id, activation_id, token_jti, status,
           client_version, ip_address, issued_at, expires_at, offline_until
         ) VALUES ($1,$2,$3,$4,$5,'VALID',$6,$7,$8,$9,$10)`,
        [input.newSessionId, row.tenant_id, row.license_id, row.activation_id, input.newTokenJti,
          input.clientVersion, input.ipAddress, input.now, tokenExpiresAt, offlineUntil],
      );
      await client.query('UPDATE activations SET last_verified_at = $2 WHERE id = $1', [row.activation_id, input.now]);
      await client.query('UPDATE devices SET last_seen_at = $2 WHERE id = $1', [row.device_id, input.now]);
      const features = await this.loadFeatures(client, row.license_id, input.now);
      await this.insertEvent(client, row, input.newSessionId, 'LICENSE_TOKEN_REFRESHED', input, { previous_session_id: row.session_id });

      return {
        ...this.toGrant(row, features),
        sessionId: input.newSessionId,
        tokenJti: input.newTokenJti,
        sessionStatus: 'VALID',
        issuedAt: input.now,
        tokenExpiresAt,
        offlineUntil,
      };
    });
  }

  public async heartbeat(input: HeartbeatRuntimeLicenseInput): Promise<RuntimeLicenseGrant> {
    return this.database.transaction(async (client) => {
      const row = await this.loadRuntimeRow(client, input, true);
      await this.validateRuntime(client, row, input);
      const previous = await client.query<{ sequence: string }>(
        `SELECT sequence::text AS sequence FROM session_heartbeats
          WHERE session_id = $1 AND result = 'ACCEPTED' AND sequence IS NOT NULL
          ORDER BY sequence DESC LIMIT 1`,
        [row.session_id],
      );
      const previousSequence = Number(previous.rows[0]?.sequence ?? 0);
      if (input.sequence <= previousSequence) {
        throw businessError('HEARTBEAT_SEQUENCE_INVALID', '心跳序号必须比上一次更大', 409);
      }
      await client.query(
        `UPDATE license_sessions SET last_heartbeat_at = $2 WHERE id = $1`,
        [row.session_id, input.now],
      );
      await client.query('UPDATE activations SET last_verified_at = $2 WHERE id = $1', [row.activation_id, input.now]);
      await client.query('UPDATE devices SET last_seen_at = $2 WHERE id = $1', [row.device_id, input.now]);
      await client.query(
        `INSERT INTO session_heartbeats
           (tenant_id, session_id, request_id, ip_address, client_version, sequence, result, received_at)
         VALUES ($1,$2,$3,$4,$5,$6,'ACCEPTED',$7)`,
        [row.tenant_id, row.session_id, input.requestId, input.ipAddress, input.clientVersion, input.sequence, input.now],
      );
      const features = await this.loadFeatures(client, row.license_id, input.now);
      await this.insertEvent(client, row, row.session_id, 'SESSION_HEARTBEAT_ACCEPTED', input, { sequence: input.sequence });
      return this.toGrant(row, features);
    });
  }

  public async releaseSession(input: RuntimeLicenseInput): Promise<SessionReleaseRuntimeResult> {
    return this.database.transaction(async (client) => {
      const row = await this.loadRuntimeRow(client, input, true);
      await this.validateRuntime(client, row, input);
      await client.query(
        `UPDATE license_sessions SET status = 'REVOKED', revoked_at = $2
          WHERE id = $1 AND status IN ('VALID', 'GRACE')`,
        [row.session_id, input.now],
      );
      await this.insertEvent(client, row, row.session_id, 'SESSION_RELEASED', input);
      return {
        tenantId: row.tenant_id,
        productId: row.product_id,
        licenseId: row.license_id,
        deviceId: row.device_id,
        activationId: row.activation_id,
        sessionId: row.session_id,
        releasedAt: input.now,
      };
    });
  }

  public async unbindDevice(input: RuntimeLicenseInput): Promise<DeviceUnbindRuntimeResult> {
    return this.database.transaction(async (client) => {
      const row = await this.loadRuntimeRow(client, input, true);
      await this.validateRuntime(client, row, input);
      assertSelfUnbindPolicy({
        allowSelfUnbind: row.allow_self_unbind,
        activatedAt: row.activation_activated_at,
        cooldownSeconds: row.unbind_cooldown_seconds,
        now: input.now,
      });
      await client.query(
        `UPDATE activations SET status = 'UNBOUND', unbound_at = $2, unbound_by = NULL
          WHERE id = $1 AND status = 'ACTIVE'`,
        [row.activation_id, input.now],
      );
      const revoked = await client.query<{ id: string }>(
        `UPDATE license_sessions SET status = 'REVOKED', revoked_at = $2
          WHERE activation_id = $1 AND status IN ('VALID', 'GRACE')
          RETURNING id::text AS id`,
        [row.activation_id, input.now],
      );
      await this.insertEvent(client, row, row.session_id, 'DEVICE_SELF_UNBOUND', input, {
        revoked_session_count: revoked.rows.length,
      });
      return {
        tenantId: row.tenant_id,
        productId: row.product_id,
        licenseId: row.license_id,
        deviceId: row.device_id,
        activationId: row.activation_id,
        unboundAt: input.now,
        revokedSessionIds: revoked.rows.map((item) => item.id),
      };
    });
  }

  public async revokeSession(sessionId: string, now: Date): Promise<void> {
    await this.database.query(
      `UPDATE license_sessions SET status = 'REVOKED', revoked_at = $2
        WHERE id = $1 AND status IN ('VALID', 'GRACE')`,
      [sessionId, now],
    );
  }

  private async loadRuntimeRow(client: PoolClient, input: RuntimeLicenseInput, lock: boolean): Promise<RuntimeRow> {
    const result = await client.query<RuntimeRow>(
      `SELECT t.id AS tenant_id, t.status AS tenant_status,
              p.id AS product_id, p.code AS product_code, p.status AS product_status,
              p.minimum_client_version, p.force_update_version,
              pv.status AS client_version_status, pv.force_update AS client_version_force_update,
              lk.id AS license_id, lk.status AS license_status, lk.license_type,
              lk.starts_at AS license_starts_at, lk.expires_at AS license_expires_at,
              lk.max_devices, lk.max_concurrent_sessions, lk.offline_grace_seconds,
              lk.allow_self_unbind, lk.unbind_cooldown_seconds,
              d.id AS device_id, d.status AS device_status, d.device_public_key,
              d.device_public_key_fingerprint, d.fingerprint_hash,
              a.id AS activation_id, a.status AS activation_status, a.activated_at AS activation_activated_at,
              a.metadata->>'device_key_id' AS device_key_id,
              s.id AS session_id, s.token_jti::text AS token_jti, s.status AS session_status,
              s.issued_at AS session_issued_at, s.expires_at AS session_expires_at,
              s.offline_until AS session_offline_until
         FROM license_sessions s
         JOIN activations a ON a.id = s.activation_id
         JOIN devices d ON d.id = a.device_id
         JOIN license_keys lk ON lk.id = s.license_key_id AND lk.id = a.license_key_id
         JOIN products p ON p.id = lk.product_id
         JOIN tenants t ON t.id = lk.tenant_id
         LEFT JOIN product_versions pv ON pv.product_id = p.id AND pv.version = $8
        WHERE t.id = $1 AND p.code = $2 AND lk.id = $3 AND d.id = $4
          AND a.id = $5 AND s.id = $6 AND s.token_jti = $7::uuid
        LIMIT 1${lock ? ' FOR UPDATE OF lk, d, a, s' : ''}`,
      [input.tenantId, input.productCode, input.licenseId, input.deviceId,
        input.activationId, input.sessionId, input.tokenJti, input.clientVersion],
    );
    const row = result.rows[0];
    if (row === undefined) throw businessError('SESSION_NOT_FOUND', '服务器找不到当前授权会话', 401);
    return row;
  }

  private async validateRuntime(client: PoolClient, row: RuntimeRow, input: RuntimeLicenseInput): Promise<void> {
    if (row.tenant_status !== 'ACTIVE') throw businessError('TENANT_DISABLED', '授权所属租户已停用', 403);
    if (row.product_status !== 'ACTIVE') throw businessError('PRODUCT_DISABLED', '产品已停用', 403);
    if (row.client_version_status === 'BLOCKED') throw businessError('CLIENT_VERSION_BLOCKED', '当前客户端版本已被禁止使用', 426);
    if (row.client_version_force_update === true ||
      (row.force_update_version !== null && compareVersions(input.clientVersion, row.force_update_version) < 0)) {
      throw businessError('FORCE_UPDATE_REQUIRED', '必须升级客户端后才能继续验证授权', 426);
    }
    if (row.minimum_client_version !== null && compareVersions(input.clientVersion, row.minimum_client_version) < 0) {
      throw businessError('CLIENT_VERSION_TOO_OLD', '客户端版本低于最低支持版本', 426);
    }

    if (row.license_status === 'SUSPENDED') throw businessError('LICENSE_SUSPENDED', '授权已被冻结', 403);
    if (row.license_status === 'REVOKED') throw businessError('LICENSE_REVOKED', '授权已吊销', 403);
    if (row.license_status === 'EXPIRED') throw businessError('LICENSE_EXPIRED', '授权已到期', 403);
    if (row.license_status !== 'ACTIVE') throw businessError('LICENSE_INVALID', '授权当前不可用', 403);
    if (row.license_starts_at !== null && row.license_starts_at > input.now) throw businessError('LICENSE_NOT_STARTED', '授权尚未开始', 403);
    if (row.license_expires_at !== null && row.license_expires_at <= input.now) throw businessError('LICENSE_EXPIRED', '授权已到期', 403);

    if (row.device_status !== 'ACTIVE') throw businessError('DEVICE_BLOCKED', '设备已被封禁或停用', 403);
    if (row.activation_status === 'BLOCKED') throw businessError('DEVICE_BLOCKED', '当前授权的设备绑定已封禁', 403);
    if (row.activation_status !== 'ACTIVE') throw businessError('DEVICE_UNBOUND', '当前设备绑定已失效', 403);
    if (row.device_key_id === null) throw businessError('DEVICE_CREDENTIAL_INVALID', '设备密钥编号缺失', 401);
    const blocked = await client.query(
      `SELECT 1 FROM device_blocks WHERE tenant_id = $1 AND status = 'ACTIVE'
        AND (device_id = $2 OR fingerprint_hash = $3) LIMIT 1`,
      [row.tenant_id, row.device_id, row.fingerprint_hash],
    );
    if ((blocked.rowCount ?? 0) > 0) throw businessError('DEVICE_BLOCKED', '设备已被封禁', 403);

    if (row.session_status === 'REVOKED') throw businessError('SESSION_REVOKED', '当前授权会话已撤销', 401);
    if (row.session_status === 'EXPIRED' || row.session_expires_at <= input.now) throw businessError('SESSION_EXPIRED', '当前授权会话已过期', 401);
    if (row.session_status !== 'VALID' && row.session_status !== 'GRACE') throw businessError('SESSION_INVALID', '当前授权会话不可用', 401);
  }

  private async loadFeatures(client: PoolClient, licenseId: string, now: Date): Promise<readonly RuntimeFeature[]> {
    const result = await client.query<FeatureRow>(
      `SELECT fd.code, fg.allowed, fg.limits, fg.expires_at
         FROM feature_grants fg JOIN feature_definitions fd ON fd.id = fg.feature_id
        WHERE fg.license_key_id = $1 AND fd.status = 'ACTIVE'
          AND (fg.expires_at IS NULL OR fg.expires_at > $2)
        ORDER BY fd.code`,
      [licenseId, now],
    );
    return result.rows.map((row) => ({ code: row.code, allowed: row.allowed, limits: row.limits, expiresAt: row.expires_at }));
  }

  private toGrant(row: RuntimeRow, features: readonly RuntimeFeature[]): RuntimeLicenseGrant {
    return {
      tenantId: row.tenant_id,
      productId: row.product_id,
      productCode: row.product_code,
      licenseId: row.license_id,
      licenseType: row.license_type,
      licenseStatus: 'ACTIVE',
      licenseExpiresAt: row.license_expires_at,
      deviceId: row.device_id,
      activationId: row.activation_id,
      sessionId: row.session_id,
      tokenJti: row.token_jti,
      sessionStatus: row.session_status as 'VALID' | 'GRACE',
      issuedAt: row.session_issued_at,
      tokenExpiresAt: row.session_expires_at,
      offlineUntil: row.session_offline_until,
      devicePublicKeyFingerprint: row.device_public_key_fingerprint,
      deviceKeyId: row.device_key_id!,
      maxDevices: row.max_devices,
      maxConcurrentSessions: row.max_concurrent_sessions,
      features,
    };
  }

  private async insertEvent(
    client: PoolClient,
    row: RuntimeRow,
    sessionId: string,
    eventType: string,
    input: RuntimeLicenseInput,
    metadata: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    await client.query(
      `INSERT INTO license_events (
         tenant_id, product_id, license_key_id, device_id, activation_id, session_id,
         event_type, result, request_id, ip_address, metadata, occurred_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'SUCCESS',$8,$9,$10::jsonb,$11)`,
      [row.tenant_id, row.product_id, row.license_id, row.device_id, row.activation_id, sessionId,
        eventType, input.requestId, input.ipAddress, JSON.stringify({ client_version: input.clientVersion, ...metadata }), input.now],
    );
  }
}

function minDate(candidate: Date, limit: Date | null): Date {
  return limit !== null && limit < candidate ? limit : candidate;
}

function minNullableDate(candidate: Date, limit: Date | null): Date {
  return limit !== null && limit < candidate ? limit : candidate;
}

function businessError(code: string, message: string, statusCode: number): AppError {
  return new AppError({ code, message, statusCode });
}


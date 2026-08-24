import type { PoolClient } from 'pg';
import type { PostgresDatabase } from '../../../infrastructure/database/postgres-database.js';
import { AppError } from '../../../shared/errors/app-error.js';
import { compareVersions } from '../../../shared/version.js';
import type { ActivationFeature, ActivationGrant, ActivationRepository, PersistActivationInput } from '../activation.repository.js';

interface LicenseActivationRow {
  id: string;
  tenant_id: string;
  product_id: string;
  policy_id: string | null;
  status: string;
  license_type: string;
  starts_at: Date | null;
  expires_at: Date | null;
  duration_seconds: string | number | null;
  max_devices: number;
  max_concurrent_sessions: number;
  offline_grace_seconds: number;
  product_code: string;
  product_status: string;
  minimum_client_version: string | null;
  force_update_version: string | null;
  client_version_status: string | null;
  client_version_force_update: boolean | null;
}

interface DeviceRow {
  id: string;
  fingerprint_hash: string;
  status: string;
}

interface ActivationRow {
  id: string;
  status: string;
}

interface FeatureRow {
  code: string;
  allowed: boolean;
  limits: Readonly<Record<string, unknown>>;
  expires_at: Date | null;
}

export class PostgresActivationRepository implements ActivationRepository {
  public constructor(private readonly database: PostgresDatabase) {}

  public async activate(input: PersistActivationInput): Promise<ActivationGrant> {
    return this.database.transaction(async (client) => {
      const license = await this.lockLicense(client, input);
      this.checkProductAndVersion(license, input.clientVersion);
      const { startsAt, expiresAt } = this.resolveLicenseWindow(license, input.now);
      this.checkLicenseStatus(license, input.now, expiresAt);

      const device = await this.findOrCreateDevice(client, license, input);
      await this.checkDeviceBlock(client, license.tenant_id, device.id, input.deviceFingerprintHash);
      const activation = await this.findOrCreateActivation(client, license, device, input);

      if (license.status === 'CREATED') {
        await client.query(
          `UPDATE license_keys
             SET status = 'ACTIVE', starts_at = $2, expires_at = $3, activated_at = COALESCE(activated_at, $2)
           WHERE id = $1`,
          [license.id, startsAt, expiresAt],
        );
      }

      await client.query(
        `UPDATE license_sessions
           SET status = 'REVOKED', revoked_at = $2
         WHERE activation_id = $1 AND status IN ('VALID', 'GRACE')`,
        [activation.id, input.now],
      );
      const activeSessions = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM license_sessions
          WHERE license_key_id = $1
            AND status IN ('VALID', 'GRACE')
            AND expires_at > $2`,
        [license.id, input.now],
      );
      if (Number(activeSessions.rows[0]?.count ?? 0) >= license.max_concurrent_sessions) {
        throw businessError('LICENSE_CONCURRENCY_LIMIT_REACHED', '授权同时在线数量已达到上限', 409);
      }

      const tokenExpiresAt = minDate(
        new Date(input.now.getTime() + input.tokenTtlSeconds * 1_000),
        expiresAt,
      );
      if (tokenExpiresAt.getTime() <= input.now.getTime()) {
        throw businessError('LICENSE_EXPIRED', '授权已到期', 403);
      }
      const offlineCandidate = new Date(tokenExpiresAt.getTime() + license.offline_grace_seconds * 1_000);
      const offlineUntil = minNullableDate(offlineCandidate, expiresAt);

      await client.query(
        `INSERT INTO license_sessions (
           id, tenant_id, license_key_id, activation_id, token_jti, status,
           client_version, ip_address, issued_at, expires_at, offline_until
         ) VALUES ($1,$2,$3,$4,$5,'VALID',$6,$7,$8,$9,$10)`,
        [input.sessionId, license.tenant_id, license.id, activation.id, input.tokenJti,
          input.clientVersion, input.ipAddress, input.now, tokenExpiresAt, offlineUntil],
      );

      const features = await this.loadFeatures(client, license.id, input.now);
      await client.query(
        `INSERT INTO license_events (
           tenant_id, product_id, license_key_id, device_id, activation_id, session_id,
           event_type, result, request_id, ip_address, metadata, occurred_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'SUCCESS',$8,$9,$10::jsonb,$11)`,
        [license.tenant_id, license.product_id, license.id, device.id, activation.id, input.sessionId,
          activation.repeated ? 'LICENSE_REACTIVATED' : 'LICENSE_ACTIVATED', input.requestId, input.ipAddress,
          JSON.stringify({ client_version: input.clientVersion, platform: input.platform, device_key_id: input.deviceKeyId }), input.now],
      );
      await client.query(
        `UPDATE devices SET last_seen_at = $2, display_name = COALESCE($3, display_name),
          os_version = COALESCE($4, os_version) WHERE id = $1`,
        [device.id, input.now, input.deviceName, input.osVersion],
      );

      return {
        tenantId: license.tenant_id,
        productId: license.product_id,
        productCode: license.product_code,
        licenseId: license.id,
        licenseType: license.license_type,
        licenseStatus: 'ACTIVE',
        licenseExpiresAt: expiresAt,
        deviceId: device.id,
        activationId: activation.id,
        sessionId: input.sessionId,
        tokenJti: input.tokenJti,
        issuedAt: input.now,
        tokenExpiresAt,
        offlineUntil,
        repeatedActivation: activation.repeated,
        devicePublicKeyFingerprint: input.devicePublicKeyFingerprint,
        deviceKeyId: input.deviceKeyId,
        maxDevices: license.max_devices,
        maxConcurrentSessions: license.max_concurrent_sessions,
        features,
      } satisfies ActivationGrant;
    });
  }

  public async revokeSession(sessionId: string, now: Date): Promise<void> {
    await this.database.query(
      `UPDATE license_sessions SET status = 'REVOKED', revoked_at = $2
       WHERE id = $1 AND status IN ('VALID', 'GRACE')`,
      [sessionId, now],
    );
  }

  private async lockLicense(client: PoolClient, input: PersistActivationInput): Promise<LicenseActivationRow> {
    const result = await client.query<LicenseActivationRow>(
      `SELECT lk.id, lk.tenant_id, lk.product_id, lk.policy_id, lk.status, lk.license_type,
              lk.starts_at, lk.expires_at, lk.duration_seconds, lk.max_devices,
              lk.max_concurrent_sessions, lk.offline_grace_seconds,
              p.code AS product_code, p.status AS product_status,
              p.minimum_client_version, p.force_update_version,
              pv.status AS client_version_status, pv.force_update AS client_version_force_update
         FROM license_keys lk
         JOIN products p ON p.id = lk.product_id
         LEFT JOIN product_versions pv ON pv.product_id = p.id AND pv.version = $3
        WHERE p.code = $1 AND lk.key_hash = $2
        LIMIT 2
        FOR UPDATE OF lk`,
      [input.productCode, input.keyHash, input.clientVersion],
    );
    if (result.rows.length !== 1 || result.rows[0] === undefined) {
      throw businessError('LICENSE_INVALID', 'Key 无效或与产品不匹配', 404);
    }
    return result.rows[0];
  }

  private checkProductAndVersion(license: LicenseActivationRow, clientVersion: string): void {
    if (license.product_status !== 'ACTIVE') throw businessError('PRODUCT_DISABLED', '产品已停用', 403);
    if (license.client_version_status === 'BLOCKED') {
      throw businessError('CLIENT_VERSION_BLOCKED', '当前客户端版本已被禁止使用', 426);
    }
    if (license.client_version_force_update === true ||
      (license.force_update_version !== null && compareVersions(clientVersion, license.force_update_version) < 0)) {
      throw businessError('FORCE_UPDATE_REQUIRED', '必须升级客户端后才能激活', 426);
    }
    if (license.minimum_client_version !== null && compareVersions(clientVersion, license.minimum_client_version) < 0) {
      throw businessError('CLIENT_VERSION_TOO_OLD', '客户端版本低于最低支持版本', 426);
    }
  }

  private resolveLicenseWindow(license: LicenseActivationRow, now: Date): { startsAt: Date; expiresAt: Date | null } {
    if (license.status !== 'CREATED') {
      if (license.license_type !== 'PERPETUAL' && license.expires_at === null) {
        throw new AppError({ code: 'LICENSE_POLICY_INVALID', message: '授权有效期快照无效', statusCode: 503 });
      }
      return { startsAt: license.starts_at ?? now, expiresAt: license.expires_at };
    }
    if (license.license_type === 'TRIAL' || license.license_type === 'DURATION') {
      const duration = license.duration_seconds === null ? NaN : Number(license.duration_seconds);
      if (!Number.isSafeInteger(duration) || duration <= 0) {
        throw new AppError({ code: 'LICENSE_POLICY_INVALID', message: '授权时长快照无效', statusCode: 503 });
      }
      const expiresAt = new Date(now.getTime() + duration * 1_000);
      if (!Number.isFinite(expiresAt.getTime())) {
        throw new AppError({ code: 'LICENSE_POLICY_INVALID', message: '授权时长超出可处理范围', statusCode: 503 });
      }
      return { startsAt: now, expiresAt };
    }
    if (license.license_type === 'FIXED_EXPIRY' && license.expires_at === null) {
      throw new AppError({ code: 'LICENSE_POLICY_INVALID', message: '固定到期授权缺少到期时间', statusCode: 503 });
    }
    return { startsAt: now, expiresAt: license.expires_at };
  }

  private checkLicenseStatus(license: LicenseActivationRow, now: Date, expiresAt: Date | null): void {
    const errors: Record<string, [string, string]> = {
      SUSPENDED: ['LICENSE_SUSPENDED', '授权已冻结'],
      REVOKED: ['LICENSE_REVOKED', '授权已永久吊销'],
      DISABLED: ['LICENSE_DISABLED', '授权已停用'],
      EXPIRED: ['LICENSE_EXPIRED', '授权已到期'],
    };
    const mapped = errors[license.status];
    if (mapped !== undefined) throw businessError(mapped[0], mapped[1], 403);
    if (license.status !== 'CREATED' && license.status !== 'ACTIVE') {
      throw businessError('LICENSE_NOT_ACTIVE', '授权状态不允许激活', 403);
    }
    if (expiresAt !== null && expiresAt.getTime() <= now.getTime()) {
      throw businessError('LICENSE_EXPIRED', '授权已到期', 403);
    }
  }

  private async findOrCreateDevice(client: PoolClient, license: LicenseActivationRow, input: PersistActivationInput): Promise<DeviceRow> {
    const result = await client.query<DeviceRow>(
      `SELECT id, fingerprint_hash, status FROM devices
        WHERE tenant_id = $1 AND device_public_key_fingerprint = $2
        FOR UPDATE`,
      [license.tenant_id, input.devicePublicKeyFingerprint],
    );
    const existing = result.rows[0];
    if (existing !== undefined) {
      if (existing.status !== 'ACTIVE') throw businessError('DEVICE_BLOCKED', '设备已被封禁或停用', 403);
      if (existing.fingerprint_hash !== input.deviceFingerprintHash) {
        throw businessError('DEVICE_FINGERPRINT_MISMATCH', '设备指纹与已登记设备不匹配', 403);
      }
      return existing;
    }

    await this.checkDeviceBlock(client, license.tenant_id, null, input.deviceFingerprintHash);
    const created = await client.query<DeviceRow>(
      `INSERT INTO devices (
         tenant_id, device_public_key, device_public_key_fingerprint, fingerprint_hash,
         platform, os_version, display_name, status, last_seen_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE',$8)
       RETURNING id, fingerprint_hash, status`,
      [license.tenant_id, input.devicePublicKey, input.devicePublicKeyFingerprint,
        input.deviceFingerprintHash, input.platform, input.osVersion, input.deviceName, input.now],
    );
    const row = created.rows[0];
    if (row === undefined) throw new Error('Failed to create device');
    return row;
  }

  private async checkDeviceBlock(client: PoolClient, tenantId: string, deviceId: string | null, fingerprintHash: string): Promise<void> {
    const blocked = await client.query(
      `SELECT 1 FROM device_blocks
        WHERE tenant_id = $1 AND status = 'ACTIVE'
          AND (fingerprint_hash = $2 OR ($3::uuid IS NOT NULL AND device_id = $3::uuid))
        LIMIT 1`,
      [tenantId, fingerprintHash, deviceId],
    );
    if (blocked.rowCount !== null && blocked.rowCount > 0) {
      throw businessError('DEVICE_BLOCKED', '设备已被封禁', 403);
    }
  }

  private async findOrCreateActivation(
    client: PoolClient,
    license: LicenseActivationRow,
    device: DeviceRow,
    input: PersistActivationInput,
  ): Promise<{ id: string; repeated: boolean }> {
    const existing = await client.query<ActivationRow>(
      `SELECT id, status FROM activations WHERE license_key_id = $1 AND device_id = $2 FOR UPDATE`,
      [license.id, device.id],
    );
    const row = existing.rows[0];
    if (row !== undefined) {
      if (row.status === 'BLOCKED') throw businessError('DEVICE_BLOCKED', '当前授权的设备绑定已封禁', 403);
      if (row.status !== 'ACTIVE') throw businessError('DEVICE_UNBOUND', '当前设备绑定已失效', 403);
      await client.query(`UPDATE activations SET last_verified_at = $2 WHERE id = $1`, [row.id, input.now]);
      return { id: row.id, repeated: true };
    }

    const count = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM activations
        WHERE license_key_id = $1 AND status = 'ACTIVE'`,
      [license.id],
    );
    if (Number(count.rows[0]?.count ?? 0) >= license.max_devices) {
      throw businessError('LICENSE_DEVICE_LIMIT_REACHED', '授权设备数量已达到上限', 409);
    }

    const created = await client.query<{ id: string }>(
      `INSERT INTO activations (tenant_id, license_key_id, device_id, status, activated_at, last_verified_at, metadata)
       VALUES ($1,$2,$3,'ACTIVE',$4,$4,$5::jsonb) RETURNING id`,
      [license.tenant_id, license.id, device.id, input.now, JSON.stringify({ device_key_id: input.deviceKeyId })],
    );
    const createdRow = created.rows[0];
    if (createdRow === undefined) throw new Error('Failed to create activation');
    return { id: createdRow.id, repeated: false };
  }

  private async loadFeatures(client: PoolClient, licenseId: string, now: Date): Promise<readonly ActivationFeature[]> {
    const result = await client.query<FeatureRow>(
      `SELECT fd.code, fg.allowed, fg.limits, fg.expires_at
         FROM feature_grants fg
         JOIN feature_definitions fd ON fd.id = fg.feature_id
        WHERE fg.license_key_id = $1
          AND fd.status = 'ACTIVE'
          AND (fg.expires_at IS NULL OR fg.expires_at > $2)
        ORDER BY fd.code`,
      [licenseId, now],
    );
    return result.rows.map((row) => ({
      code: row.code,
      allowed: row.allowed,
      limits: row.limits,
      expiresAt: row.expires_at,
    }));
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


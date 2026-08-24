import type { PoolClient, QueryResultRow } from 'pg';
import type { PostgresDatabase } from '../../../infrastructure/database/postgres-database.js';
import { AppError } from '../../../shared/errors/app-error.js';
import type {
  ActivationStatus,
  AdminDeviceActionInput,
  AdminDeviceRepository,
  BlockDeviceResult,
  DeviceActionSnapshot,
  DeviceBindingListInput,
  DeviceStatus,
  ForceUnbindDeviceInput,
  ForceUnbindDeviceResult,
  ManagedDeviceBinding,
  UnblockDeviceResult,
} from '../admin-device.repository.js';

interface DeviceBindingRow extends QueryResultRow {
  device_id: string;
  tenant_id: string;
  license_id: string;
  activation_id: string;
  device_status: DeviceStatus;
  activation_status: ActivationStatus;
  platform: string;
  os_version: string | null;
  display_name: string | null;
  device_public_key_fingerprint: string;
  fingerprint_hash: string;
  risk_score: number;
  first_seen_at: Date;
  last_seen_at: Date | null;
  activated_at: Date;
  last_verified_at: Date | null;
  unbound_at: Date | null;
  active_session_count: string;
  blocked: boolean;
  block_reason: string | null;
  blocked_at: Date | null;
}

interface LockedDeviceRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  status: DeviceStatus;
  fingerprint_hash: string;
}

interface LockedActivationRow extends QueryResultRow {
  activation_id: string;
  activation_status: ActivationStatus;
  unbound_at: Date | null;
  license_id: string;
  product_id: string;
}

interface ActivationSnapshotRow extends QueryResultRow {
  activation_id: string;
  license_id: string;
  status: ActivationStatus;
}

interface BlockRow extends QueryResultRow {
  id: string;
  blocked_at: Date;
}

export class PostgresAdminDeviceRepository implements AdminDeviceRepository {
  public constructor(private readonly database: PostgresDatabase) {}

  public async listLicenseDevices(input: DeviceBindingListInput): Promise<readonly ManagedDeviceBinding[]> {
    const license = await this.database.query(
      'SELECT 1 FROM license_keys WHERE tenant_id=$1 AND id=$2',
      [input.tenantId, input.licenseId],
    );
    if ((license.rowCount ?? 0) === 0) throw notFound('LICENSE_NOT_FOUND', '授权不存在');

    const result = await this.database.query<DeviceBindingRow>(
      `SELECT d.id AS device_id, d.tenant_id, a.license_key_id AS license_id,
              a.id AS activation_id, d.status AS device_status, a.status AS activation_status,
              d.platform, d.os_version, d.display_name, d.device_public_key_fingerprint,
              d.fingerprint_hash, d.risk_score, d.first_seen_at, d.last_seen_at,
              a.activated_at, a.last_verified_at, a.unbound_at,
              (SELECT COUNT(*)::text FROM license_sessions s
                WHERE s.activation_id=a.id AND s.status IN ('VALID','GRACE')) AS active_session_count,
              (active_block.id IS NOT NULL) AS blocked,
              active_block.reason AS block_reason, active_block.blocked_at
         FROM activations a
         JOIN devices d ON d.id=a.device_id AND d.tenant_id=a.tenant_id
         LEFT JOIN LATERAL (
           SELECT db.id, db.reason, db.blocked_at
             FROM device_blocks db
            WHERE db.tenant_id=d.tenant_id AND db.status='ACTIVE'
              AND (db.device_id=d.id OR db.fingerprint_hash=d.fingerprint_hash)
            ORDER BY db.blocked_at DESC, db.id DESC LIMIT 1
         ) active_block ON TRUE
        WHERE a.tenant_id=$1 AND a.license_key_id=$2
          AND ($3::varchar IS NULL OR a.status=$3)
        ORDER BY a.activated_at DESC, a.id DESC
        LIMIT $4 OFFSET $5`,
      [input.tenantId, input.licenseId, input.activationStatus ?? null, input.limit, input.offset],
    );
    return result.rows.map(mapBinding);
  }

  public async forceUnbind(input: ForceUnbindDeviceInput): Promise<ForceUnbindDeviceResult> {
    return this.database.transaction(async (client) => {
      const device = await this.lockDevice(client, input.tenantId, input.deviceId);
      const activationResult = await client.query<LockedActivationRow>(
        `SELECT a.id AS activation_id, a.status AS activation_status, a.unbound_at,
                a.license_key_id AS license_id, lk.product_id
           FROM activations a
           JOIN license_keys lk ON lk.id=a.license_key_id AND lk.tenant_id=a.tenant_id
          WHERE a.tenant_id=$1 AND a.device_id=$2 AND a.license_key_id=$3
          FOR UPDATE OF a, lk`,
        [input.tenantId, input.deviceId, input.licenseId],
      );
      const activation = activationResult.rows[0];
      if (activation === undefined) throw notFound('DEVICE_BINDING_NOT_FOUND', '这个 Key 没有该设备绑定记录');
      if (activation.activation_status === 'REPLACED') {
        throw new AppError({ code: 'DEVICE_BINDING_NOT_UNBINDABLE', message: '已被换机替代的绑定不能再次解绑', statusCode: 409 });
      }

      const before = await this.snapshot(client, device);
      const changed = activation.activation_status !== 'UNBOUND';
      if (changed) {
        await client.query(
          `UPDATE activations
              SET status='UNBOUND', unbound_at=$2, unbound_by=$3
            WHERE id=$1`,
          [activation.activation_id, input.now, input.adminUserId],
        );
      }
      const revoked = await client.query<{ id: string }>(
        `UPDATE license_sessions
            SET status='REVOKED', revoked_at=$2
          WHERE activation_id=$1 AND status IN ('VALID','GRACE')
          RETURNING id`,
        [activation.activation_id, input.now],
      );
      await this.insertSingleEvent(client, {
        ...input,
        productId: activation.product_id,
        licenseId: activation.license_id,
        activationId: activation.activation_id,
        eventType: 'ADMIN_DEVICE_UNBOUND',
        metadata: {
          reason: input.reason,
          admin_user_id: input.adminUserId,
          previous_activation_status: activation.activation_status,
          changed,
          revoked_session_count: revoked.rows.length,
        },
      });
      const after = await this.snapshot(client, { ...device, status: device.status });
      return {
        deviceId: input.deviceId,
        licenseId: activation.license_id,
        activationId: activation.activation_id,
        previousActivationStatus: activation.activation_status,
        activationStatus: 'UNBOUND',
        unboundAt: changed ? input.now : (activation.unbound_at ?? input.now),
        revokedSessionIds: revoked.rows.map((row) => row.id),
        changed,
        before,
        after,
      };
    });
  }

  public async block(input: AdminDeviceActionInput): Promise<BlockDeviceResult> {
    return this.database.transaction(async (client) => {
      const device = await this.lockDevice(client, input.tenantId, input.deviceId);
      if (device.status === 'DISABLED') {
        throw new AppError({ code: 'DEVICE_DISABLED', message: '停用设备不能改为封禁状态', statusCode: 409 });
      }
      const before = await this.snapshot(client, device);
      const existingBlock = await client.query<BlockRow>(
        `SELECT id, blocked_at FROM device_blocks
          WHERE tenant_id=$1 AND status='ACTIVE'
            AND (device_id=$2 OR fingerprint_hash=$3)
          ORDER BY blocked_at DESC, id DESC LIMIT 1 FOR UPDATE`,
        [input.tenantId, input.deviceId, device.fingerprint_hash],
      );
      let block = existingBlock.rows[0];
      if (block === undefined) {
        const inserted = await client.query<BlockRow>(
          `INSERT INTO device_blocks (
             tenant_id, device_id, fingerprint_hash, reason, status, blocked_by, blocked_at
           ) VALUES ($1,$2,$3,$4,'ACTIVE',$5,$6)
           RETURNING id, blocked_at`,
          [input.tenantId, input.deviceId, device.fingerprint_hash, input.reason, input.adminUserId, input.now],
        );
        block = inserted.rows[0];
        if (block === undefined) throw new Error('Failed to create device block');
      }

      const blockedActivations = await client.query<{ id: string }>(
        `UPDATE activations SET status='BLOCKED'
          WHERE tenant_id=$1 AND device_id=$2 AND status='ACTIVE'
          RETURNING id`,
        [input.tenantId, input.deviceId],
      );
      const revoked = await client.query<{ id: string }>(
        `UPDATE license_sessions s SET status='REVOKED', revoked_at=$3
          FROM activations a
          WHERE a.id=s.activation_id AND a.tenant_id=$1 AND a.device_id=$2
            AND s.status IN ('VALID','GRACE')
          RETURNING s.id`,
        [input.tenantId, input.deviceId, input.now],
      );
      await client.query(
        `UPDATE devices SET status='BLOCKED' WHERE tenant_id=$1 AND id=$2`,
        [input.tenantId, input.deviceId],
      );
      const changed = device.status !== 'BLOCKED' || existingBlock.rows[0] === undefined || blockedActivations.rows.length > 0 || revoked.rows.length > 0;
      await this.insertDeviceEvents(client, input, 'ADMIN_DEVICE_BLOCKED', {
        reason: input.reason,
        admin_user_id: input.adminUserId,
        block_id: block.id,
        changed,
        blocked_activation_count: blockedActivations.rows.length,
        revoked_session_count: revoked.rows.length,
      }, ['BLOCKED']);
      const after = await this.snapshot(client, { ...device, status: 'BLOCKED' });
      return {
        deviceId: input.deviceId,
        deviceStatus: 'BLOCKED',
        blockId: block.id,
        blockedAt: block.blocked_at,
        blockedActivationCount: blockedActivations.rows.length,
        revokedSessionIds: revoked.rows.map((row) => row.id),
        changed,
        before,
        after,
      };
    });
  }

  public async unblock(input: AdminDeviceActionInput): Promise<UnblockDeviceResult> {
    return this.database.transaction(async (client) => {
      const device = await this.lockDevice(client, input.tenantId, input.deviceId);
      const before = await this.snapshot(client, device);
      const released = await client.query<{ id: string }>(
        `UPDATE device_blocks
            SET status='RELEASED', released_by=$4, released_at=$5
          WHERE tenant_id=$1 AND status='ACTIVE'
            AND (device_id=$2 OR fingerprint_hash=$3)
          RETURNING id`,
        [input.tenantId, input.deviceId, device.fingerprint_hash, input.adminUserId, input.now],
      );
      const targetStatus: DeviceStatus = device.status === 'BLOCKED' ? 'ACTIVE' : device.status;
      if (targetStatus !== device.status) {
        await client.query(
          `UPDATE devices SET status=$3 WHERE tenant_id=$1 AND id=$2`,
          [input.tenantId, input.deviceId, targetStatus],
        );
      }
      const changed = released.rows.length > 0 || targetStatus !== device.status;
      await this.insertDeviceEvents(client, input, 'ADMIN_DEVICE_UNBLOCKED', {
        reason: input.reason,
        admin_user_id: input.adminUserId,
        changed,
        released_block_count: released.rows.length,
        old_bindings_restored: false,
        old_sessions_restored: false,
      }, ['BLOCKED']);
      const after = await this.snapshot(client, { ...device, status: targetStatus });
      return {
        deviceId: input.deviceId,
        deviceStatus: targetStatus,
        releasedBlockCount: released.rows.length,
        releasedAt: input.now,
        changed,
        before,
        after,
      };
    });
  }

  private async lockDevice(client: PoolClient, tenantId: string, deviceId: string): Promise<LockedDeviceRow> {
    const result = await client.query<LockedDeviceRow>(
      `SELECT id, tenant_id, status, fingerprint_hash
         FROM devices WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
      [tenantId, deviceId],
    );
    const row = result.rows[0];
    if (row === undefined) throw notFound('DEVICE_NOT_FOUND', '设备不存在');
    return row;
  }

  private async snapshot(client: PoolClient, device: LockedDeviceRow): Promise<DeviceActionSnapshot> {
    const activations = await client.query<ActivationSnapshotRow>(
      `SELECT id AS activation_id, license_key_id AS license_id, status
         FROM activations WHERE tenant_id=$1 AND device_id=$2
         ORDER BY activated_at, id`,
      [device.tenant_id, device.id],
    );
    return {
      deviceId: device.id,
      deviceStatus: device.status,
      activationStatuses: activations.rows.map((row) => ({
        activationId: row.activation_id,
        licenseId: row.license_id,
        status: row.status,
      })),
    };
  }

  private async insertDeviceEvents(
    client: PoolClient,
    input: AdminDeviceActionInput,
    eventType: string,
    metadata: Readonly<Record<string, unknown>>,
    activationStatuses: readonly ActivationStatus[],
  ): Promise<void> {
    const inserted = await client.query(
      `INSERT INTO license_events (
         tenant_id, product_id, license_key_id, device_id, activation_id,
         event_type, result, request_id, ip_address, metadata, occurred_at
       )
       SELECT a.tenant_id, lk.product_id, a.license_key_id, a.device_id, a.id,
              $3, 'SUCCESS', $4, $5, $6::jsonb, $7
         FROM activations a JOIN license_keys lk ON lk.id=a.license_key_id
        WHERE a.tenant_id=$1 AND a.device_id=$2 AND a.status=ANY($8::varchar[])`,
      [input.tenantId, input.deviceId, eventType, input.requestId, input.ipAddress, JSON.stringify(metadata), input.now, [...activationStatuses]],
    );
    if ((inserted.rowCount ?? 0) === 0) {
      await client.query(
        `INSERT INTO license_events (
           tenant_id, device_id, event_type, result, request_id, ip_address, metadata, occurred_at
         ) VALUES ($1,$2,$3,'SUCCESS',$4,$5,$6::jsonb,$7)`,
        [input.tenantId, input.deviceId, eventType, input.requestId, input.ipAddress, JSON.stringify(metadata), input.now],
      );
    }
  }

  private async insertSingleEvent(
    client: PoolClient,
    input: ForceUnbindDeviceInput & {
      productId: string;
      activationId: string;
      eventType: string;
      metadata: Readonly<Record<string, unknown>>;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO license_events (
         tenant_id, product_id, license_key_id, device_id, activation_id,
         event_type, result, request_id, ip_address, metadata, occurred_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'SUCCESS',$7,$8,$9::jsonb,$10)`,
      [input.tenantId, input.productId, input.licenseId, input.deviceId, input.activationId,
        input.eventType, input.requestId, input.ipAddress, JSON.stringify(input.metadata), input.now],
    );
  }
}

function mapBinding(row: DeviceBindingRow): ManagedDeviceBinding {
  return {
    deviceId: row.device_id,
    tenantId: row.tenant_id,
    licenseId: row.license_id,
    activationId: row.activation_id,
    deviceStatus: row.device_status,
    activationStatus: row.activation_status,
    platform: row.platform,
    osVersion: row.os_version,
    displayName: row.display_name,
    devicePublicKeyFingerprint: row.device_public_key_fingerprint,
    fingerprintHash: row.fingerprint_hash,
    riskScore: row.risk_score,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    activatedAt: row.activated_at,
    lastVerifiedAt: row.last_verified_at,
    unboundAt: row.unbound_at,
    activeSessionCount: Number(row.active_session_count),
    blocked: row.blocked,
    blockReason: row.block_reason,
    blockedAt: row.blocked_at,
  };
}

function notFound(code: string, message: string): AppError {
  return new AppError({ code, message, statusCode: 404 });
}




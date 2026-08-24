import type { QueryResultRow } from 'pg';
import type { PostgresDatabase } from '../../../infrastructure/database/postgres-database.js';
import type {
  AdminAuditLogRecord,
  AdminAuditQueryRepository,
  AdminLicenseEventRecord,
  AuditLogQueryInput,
  LicenseEventQueryInput,
} from '../admin-audit-query.repository.js';

interface AuditLogRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  actor_type: AdminAuditLogRecord['actorType'];
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  request_id: string | null;
  source_ip: string | null;
  user_agent: string | null;
  result: AdminAuditLogRecord['result'];
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  occurred_at: Date;
}

interface LicenseEventRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  product_id: string | null;
  license_key_id: string | null;
  device_id: string | null;
  activation_id: string | null;
  session_id: string | null;
  event_type: string;
  result: AdminLicenseEventRecord['result'];
  reason_code: string | null;
  request_id: string | null;
  ip_address: string | null;
  metadata: Record<string, unknown>;
  occurred_at: Date;
}

interface CountRow extends QueryResultRow {
  count: string;
}

export class PostgresAdminAuditQueryRepository implements AdminAuditQueryRepository {
  public constructor(private readonly database: PostgresDatabase) {}

  public async listAuditLogs(input: AuditLogQueryInput): Promise<{ items: readonly AdminAuditLogRecord[]; total: number }> {
    const query = buildQuery(
      `SELECT id, tenant_id, actor_type, actor_id, action, resource_type, resource_id,
              request_id, source_ip::text AS source_ip, user_agent, result,
              before_data, after_data, metadata, occurred_at
         FROM audit_logs`,
      input.tenantId,
      [
        ['actorType', 'actor_type'],
        ['actorId', 'actor_id'],
        ['action', 'action'],
        ['resourceType', 'resource_type'],
        ['resourceId', 'resource_id'],
        ['result', 'result'],
        ['requestId', 'request_id'],
      ],
      input,
    );
    const [itemsResult, countResult] = await Promise.all([
      this.database.query<AuditLogRow>(query.listText, query.listValues),
      this.database.query<CountRow>(query.countText, query.filterValues),
    ]);
    return { items: itemsResult.rows.map(mapAuditLog), total: Number(countResult.rows[0]?.count ?? 0) };
  }

  public async listLicenseEvents(input: LicenseEventQueryInput): Promise<{ items: readonly AdminLicenseEventRecord[]; total: number }> {
    const query = buildQuery(
      `SELECT id, tenant_id, product_id, license_key_id, device_id, activation_id,
              session_id, event_type, result, reason_code, request_id,
              ip_address::text AS ip_address, metadata, occurred_at
         FROM license_events`,
      input.tenantId,
      [
        ['productId', 'product_id'],
        ['licenseId', 'license_key_id'],
        ['deviceId', 'device_id'],
        ['activationId', 'activation_id'],
        ['sessionId', 'session_id'],
        ['eventType', 'event_type'],
        ['result', 'result'],
        ['reasonCode', 'reason_code'],
        ['requestId', 'request_id'],
      ],
      input,
    );
    const [itemsResult, countResult] = await Promise.all([
      this.database.query<LicenseEventRow>(query.listText, query.listValues),
      this.database.query<CountRow>(query.countText, query.filterValues),
    ]);
    return { items: itemsResult.rows.map(mapLicenseEvent), total: Number(countResult.rows[0]?.count ?? 0) };
  }
}

type QueryInput = AuditLogQueryInput | LicenseEventQueryInput;
type FilterEntry = readonly [string, string];

function buildQuery(
  selectSql: string,
  tenantId: string,
  filters: readonly FilterEntry[],
  input: QueryInput,
): { listText: string; countText: string; filterValues: unknown[]; listValues: unknown[] } {
  const conditions = ['tenant_id = $1'];
  const filterValues: unknown[] = [tenantId];

  for (const [property, column] of filters) {
    const value = (input as unknown as Record<string, unknown>)[property];
    if (value === undefined) continue;
    filterValues.push(value);
    conditions.push(`${column} = $${filterValues.length}`);
  }

  if (input.occurredFrom !== undefined) {
    filterValues.push(input.occurredFrom);
    conditions.push(`occurred_at >= $${filterValues.length}`);
  }
  if (input.occurredTo !== undefined) {
    filterValues.push(input.occurredTo);
    conditions.push(`occurred_at <= $${filterValues.length}`);
  }

  const listValues = [...filterValues, input.limit, input.offset];
  const limitPlaceholder = `$${filterValues.length + 1}`;
  const offsetPlaceholder = `$${filterValues.length + 2}`;
  const whereSql = `WHERE ${conditions.join(' AND ')}`;

  return {
    listText: `${selectSql}\n${whereSql}\nORDER BY occurred_at DESC, id DESC\nLIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
    countText: `SELECT COUNT(*)::text AS count FROM (${selectSql}\n${whereSql}) filtered`,
    filterValues,
    listValues,
  };
}
function mapAuditLog(row: AuditLogRow): AdminAuditLogRecord {
  return {
    id: String(row.id),
    tenantId: row.tenant_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    requestId: row.request_id,
    sourceIp: row.source_ip,
    userAgent: row.user_agent,
    result: row.result,
    beforeData: row.before_data,
    afterData: row.after_data,
    metadata: row.metadata,
    occurredAt: row.occurred_at,
  };
}

function mapLicenseEvent(row: LicenseEventRow): AdminLicenseEventRecord {
  return {
    id: String(row.id),
    tenantId: row.tenant_id,
    productId: row.product_id,
    licenseId: row.license_key_id,
    deviceId: row.device_id,
    activationId: row.activation_id,
    sessionId: row.session_id,
    eventType: row.event_type,
    result: row.result,
    reasonCode: row.reason_code,
    requestId: row.request_id,
    ipAddress: row.ip_address,
    metadata: row.metadata,
    occurredAt: row.occurred_at,
  };
}


import type { PostgresDatabase } from '../../../infrastructure/database/postgres-database.js';
import type { AuditEvent, AuditLogPort } from '../audit-log.port.js';

export class PostgresAuditLog implements AuditLogPort {
  public constructor(private readonly database: PostgresDatabase) {}

  public async append(event: AuditEvent): Promise<void> {
    await this.database.query(
      `INSERT INTO audit_logs (
         tenant_id, actor_type, actor_id, action, resource_type, resource_id,
         request_id, source_ip, user_agent, result, before_data, after_data,
         metadata, occurred_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11::jsonb, $12::jsonb,
         $13::jsonb, $14
       )`,
      [
        event.actor.tenantId ?? null,
        event.actor.type,
        event.actor.id ?? null,
        event.action,
        event.resourceType,
        event.resourceId ?? null,
        event.requestId ?? null,
        event.sourceIp ?? null,
        event.userAgent ?? null,
        event.result,
        event.before === undefined ? null : JSON.stringify(event.before),
        event.after === undefined ? null : JSON.stringify(event.after),
        JSON.stringify(event.metadata ?? {}),
        event.occurredAt,
      ],
    );
  }
}

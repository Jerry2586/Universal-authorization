import type { Clock } from '../challenges/challenge.service.js';
import type { AuditLogPort } from '../audit/audit-log.port.js';
import type { ManagementRequestContext } from '../identity/admin-principal.js';
import type { PageResult } from '../../shared/pagination/page-result.js';
import type {
  AdminAuditLogRecord,
  AdminAuditQueryRepository,
  AdminLicenseEventRecord,
  AuditLogQueryInput,
  LicenseEventQueryInput,
} from './admin-audit-query.repository.js';

export type AuditLogFilters = Omit<AuditLogQueryInput, 'tenantId'>;
export type LicenseEventFilters = Omit<LicenseEventQueryInput, 'tenantId'>;

export class AdminAuditQueryService {
  public constructor(
    private readonly repository: AdminAuditQueryRepository,
    private readonly auditLog: AuditLogPort,
    private readonly clock: Clock = () => new Date(),
  ) {}

  public async listAuditLogs(
    context: ManagementRequestContext,
    filters: AuditLogFilters,
  ): Promise<PageResult<AdminAuditLogRecord>> {
    const page = await this.repository.listAuditLogs({ tenantId: context.tenantId, ...filters });
    await this.recordRead(context, 'audit-log.read', 'AUDIT_LOG', filters, page.items.length);
    return page;
  }

  public async listLicenseEvents(
    context: ManagementRequestContext,
    filters: LicenseEventFilters,
  ): Promise<PageResult<AdminLicenseEventRecord>> {
    const page = await this.repository.listLicenseEvents({ tenantId: context.tenantId, ...filters });
    await this.recordRead(context, 'license-event.read', 'LICENSE_EVENT', filters, page.items.length);
    return page;
  }

  private async recordRead(
    context: ManagementRequestContext,
    action: string,
    resourceType: string,
    filters: AuditLogFilters | LicenseEventFilters,
    itemCount: number,
  ): Promise<void> {
    await this.auditLog.append({
      actor: {
        type: 'ADMIN_USER',
        id: context.principal.userId,
        tenantId: context.tenantId,
      },
      action,
      resourceType,
      resourceId: context.tenantId,
      requestId: context.requestId,
      ...(context.sourceIp === undefined ? {} : { sourceIp: context.sourceIp }),
      ...(context.userAgent === undefined ? {} : { userAgent: context.userAgent }),
      result: 'SUCCESS',
      metadata: {
        filters: serializeFilters(filters),
        item_count: itemCount,
      },
      occurredAt: this.clock(),
    });
  }
}

function serializeFilters(filters: AuditLogFilters | LicenseEventFilters): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined) continue;
    result[key] = value instanceof Date ? value.toISOString() : value;
  }
  return result;
}



export type AuditActorType = 'ADMIN_USER' | 'SYSTEM' | 'API_CLIENT';
export type EventResult = 'SUCCESS' | 'FAILURE';

export interface AdminAuditLogRecord {
  id: string;
  tenantId: string;
  actorType: AuditActorType;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  requestId: string | null;
  sourceIp: string | null;
  userAgent: string | null;
  result: EventResult;
  beforeData: Readonly<Record<string, unknown>> | null;
  afterData: Readonly<Record<string, unknown>> | null;
  metadata: Readonly<Record<string, unknown>>;
  occurredAt: Date;
}

export interface AdminLicenseEventRecord {
  id: string;
  tenantId: string;
  productId: string | null;
  licenseId: string | null;
  deviceId: string | null;
  activationId: string | null;
  sessionId: string | null;
  eventType: string;
  result: EventResult;
  reasonCode: string | null;
  requestId: string | null;
  ipAddress: string | null;
  metadata: Readonly<Record<string, unknown>>;
  occurredAt: Date;
}

export interface AuditLogQueryInput {
  tenantId: string;
  actorType?: AuditActorType;
  actorId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  result?: EventResult;
  requestId?: string;
  occurredFrom?: Date;
  occurredTo?: Date;
  limit: number;
  offset: number;
}

export interface LicenseEventQueryInput {
  tenantId: string;
  productId?: string;
  licenseId?: string;
  deviceId?: string;
  activationId?: string;
  sessionId?: string;
  eventType?: string;
  result?: EventResult;
  reasonCode?: string;
  requestId?: string;
  occurredFrom?: Date;
  occurredTo?: Date;
  limit: number;
  offset: number;
}

export interface AdminAuditQueryRepository {
  listAuditLogs(input: AuditLogQueryInput): Promise<readonly AdminAuditLogRecord[]>;
  listLicenseEvents(input: LicenseEventQueryInput): Promise<readonly AdminLicenseEventRecord[]>;
}

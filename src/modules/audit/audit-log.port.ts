export interface AuditActor {
  type: 'ADMIN_USER' | 'SYSTEM' | 'API_CLIENT';
  id?: string;
  tenantId?: string;
}

export interface AuditEvent {
  actor: AuditActor;
  action: string;
  resourceType: string;
  resourceId?: string;
  requestId?: string;
  sourceIp?: string;
  userAgent?: string;
  result: 'SUCCESS' | 'FAILURE';
  before?: Readonly<Record<string, unknown>>;
  after?: Readonly<Record<string, unknown>>;
  metadata?: Readonly<Record<string, unknown>>;
  occurredAt: Date;
}

export interface AuditLogPort {
  append(event: AuditEvent): Promise<void>;
}

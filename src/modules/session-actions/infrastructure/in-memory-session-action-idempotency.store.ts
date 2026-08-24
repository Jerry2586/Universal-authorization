import type {
  SessionActionIdempotencyClaim,
  SessionActionIdempotencyStore,
  SessionActionResponseData,
  SessionActionType,
} from '../session-action-idempotency.store.js';

interface ActionRecord {
  requestHash: string;
  status: 'PROCESSING' | 'COMPLETED';
  response?: SessionActionResponseData;
  expiresAt: Date;
}

export class InMemorySessionActionIdempotencyStore implements SessionActionIdempotencyStore {
  private readonly records = new Map<string, ActionRecord>();

  public async claim<TResponse extends SessionActionResponseData>(input: {
    actionType: SessionActionType; key: string; requestHash: string; now: Date; expiresAt: Date;
  }): Promise<SessionActionIdempotencyClaim<TResponse>> {
    const mapKey = this.mapKey(input.actionType, input.key);
    const existing = this.records.get(mapKey);
    if (existing === undefined || existing.expiresAt <= input.now) {
      this.records.set(mapKey, { requestHash: input.requestHash, status: 'PROCESSING', expiresAt: input.expiresAt });
      return { kind: 'CLAIMED' };
    }
    if (existing.requestHash !== input.requestHash) return { kind: 'CONFLICT' };
    if (existing.status === 'COMPLETED' && existing.response !== undefined) {
      return { kind: 'COMPLETED', response: existing.response as TResponse };
    }
    return { kind: 'PROCESSING' };
  }

  public async complete(input: {
    actionType: SessionActionType; key: string; requestHash: string; response: SessionActionResponseData; now: Date;
  }): Promise<void> {
    const mapKey = this.mapKey(input.actionType, input.key);
    const existing = this.records.get(mapKey);
    if (existing?.requestHash === input.requestHash) {
      this.records.set(mapKey, { ...existing, status: 'COMPLETED', response: input.response });
    }
  }

  public async release(actionType: SessionActionType, key: string, requestHash: string): Promise<void> {
    const mapKey = this.mapKey(actionType, key);
    const existing = this.records.get(mapKey);
    if (existing?.requestHash === requestHash && existing.status === 'PROCESSING') this.records.delete(mapKey);
  }

  private mapKey(actionType: SessionActionType, key: string): string {
    return `${actionType}:${key}`;
  }
}

import type { ActivationResponseData } from '../activation.service.js';
import type { ActivationIdempotencyStore, IdempotencyClaim } from '../activation-idempotency.store.js';

interface RecordValue {
  requestHash: string;
  status: 'PROCESSING' | 'COMPLETED';
  response?: ActivationResponseData;
  expiresAt: Date;
}

export class InMemoryActivationIdempotencyStore implements ActivationIdempotencyStore {
  private readonly records = new Map<string, RecordValue>();

  public async claim(input: {
    key: string;
    requestHash: string;
    now: Date;
    expiresAt: Date;
  }): Promise<IdempotencyClaim> {
    const existing = this.records.get(input.key);
    if (existing === undefined || existing.expiresAt.getTime() <= input.now.getTime()) {
      this.records.set(input.key, { requestHash: input.requestHash, status: 'PROCESSING', expiresAt: input.expiresAt });
      return { kind: 'CLAIMED' };
    }
    if (existing.requestHash !== input.requestHash) return { kind: 'CONFLICT' };
    if (existing.status === 'COMPLETED' && existing.response !== undefined) {
      return { kind: 'COMPLETED', response: existing.response };
    }
    return { kind: 'PROCESSING' };
  }

  public async complete(input: {
    key: string;
    requestHash: string;
    response: ActivationResponseData;
    now: Date;
  }): Promise<void> {
    const existing = this.records.get(input.key);
    if (existing?.requestHash === input.requestHash) {
      this.records.set(input.key, { ...existing, status: 'COMPLETED', response: input.response });
    }
  }

  public async release(key: string, requestHash: string): Promise<void> {
    const existing = this.records.get(key);
    if (existing?.requestHash === requestHash && existing.status === 'PROCESSING') this.records.delete(key);
  }
}

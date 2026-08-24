import type { ActivationResponseData } from './activation.service.js';

export type IdempotencyClaim =
  | { kind: 'CLAIMED' }
  | { kind: 'COMPLETED'; response: ActivationResponseData }
  | { kind: 'PROCESSING' }
  | { kind: 'CONFLICT' };

export interface ActivationIdempotencyStore {
  claim(input: {
    key: string;
    requestHash: string;
    now: Date;
    expiresAt: Date;
  }): Promise<IdempotencyClaim>;
  complete(input: {
    key: string;
    requestHash: string;
    response: ActivationResponseData;
    now: Date;
  }): Promise<void>;
  release(key: string, requestHash: string): Promise<void>;
}

import type { LicenseRefreshResponseData } from './license-refresh.service.js';

export type RefreshIdempotencyClaim =
  | { kind: 'CLAIMED' }
  | { kind: 'COMPLETED'; response: LicenseRefreshResponseData }
  | { kind: 'PROCESSING' }
  | { kind: 'CONFLICT' };

export interface LicenseRefreshIdempotencyStore {
  claim(input: { key: string; requestHash: string; now: Date; expiresAt: Date }): Promise<RefreshIdempotencyClaim>;
  complete(input: { key: string; requestHash: string; response: LicenseRefreshResponseData; now: Date }): Promise<void>;
  release(key: string, requestHash: string): Promise<void>;
}

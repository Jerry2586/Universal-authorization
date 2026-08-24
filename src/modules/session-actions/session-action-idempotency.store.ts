import type { DeviceUnbindResponseData } from '../devices/device-unbind.service.js';
import type { SessionReleaseResponseData } from '../sessions/session-release.service.js';

export type SessionActionType = 'SESSION_RELEASE' | 'DEVICE_UNBIND';
export type SessionActionResponseData = SessionReleaseResponseData | DeviceUnbindResponseData;

export type SessionActionIdempotencyClaim<TResponse extends SessionActionResponseData> =
  | { kind: 'CLAIMED' }
  | { kind: 'PROCESSING' }
  | { kind: 'CONFLICT' }
  | { kind: 'COMPLETED'; response: TResponse };

export interface SessionActionIdempotencyStore {
  claim<TResponse extends SessionActionResponseData>(input: {
    actionType: SessionActionType;
    key: string;
    requestHash: string;
    now: Date;
    expiresAt: Date;
  }): Promise<SessionActionIdempotencyClaim<TResponse>>;
  complete(input: {
    actionType: SessionActionType;
    key: string;
    requestHash: string;
    response: SessionActionResponseData;
    now: Date;
  }): Promise<void>;
  release(actionType: SessionActionType, key: string, requestHash: string): Promise<void>;
}

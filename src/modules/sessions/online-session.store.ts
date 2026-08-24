export interface OnlineSessionState {
  sessionId: string;
  licenseId: string;
  deviceId: string;
  activationId: string;
  lastHeartbeatAt: Date;
  sequence: number;
}

export interface OnlineSessionStore {
  markOnline(state: OnlineSessionState, ttlSeconds: number): Promise<void>;
  remove(sessionId: string): Promise<void>;
  removeMany(sessionIds: readonly string[]): Promise<void>;
}

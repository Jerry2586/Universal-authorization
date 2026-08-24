import type { OnlineSessionState, OnlineSessionStore } from '../online-session.store.js';

interface RecordValue {
  state: OnlineSessionState;
  expiresAt: Date;
}

export class InMemoryOnlineSessionStore implements OnlineSessionStore {
  private readonly records = new Map<string, RecordValue>();

  public constructor(private readonly clock: () => Date = () => new Date()) {}

  public async markOnline(state: OnlineSessionState, ttlSeconds: number): Promise<void> {
    this.records.set(state.sessionId, {
      state: { ...state },
      expiresAt: new Date(this.clock().getTime() + ttlSeconds * 1_000),
    });
  }

  public async remove(sessionId: string): Promise<void> {
    this.records.delete(sessionId);
  }

  public async removeMany(sessionIds: readonly string[]): Promise<void> {
    for (const sessionId of sessionIds) this.records.delete(sessionId);
  }

  public get(sessionId: string): OnlineSessionState | undefined {
    const record = this.records.get(sessionId);
    if (record === undefined) return undefined;
    if (record.expiresAt <= this.clock()) {
      this.records.delete(sessionId);
      return undefined;
    }
    return { ...record.state };
  }
}

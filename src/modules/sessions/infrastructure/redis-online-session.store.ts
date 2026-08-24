import type { KeyValueCache } from '../../../infrastructure/cache/key-value-cache.js';
import type { OnlineSessionState, OnlineSessionStore } from '../online-session.store.js';

export class RedisOnlineSessionStore implements OnlineSessionStore {
  public constructor(
    private readonly cache: KeyValueCache,
    private readonly keyPrefix: string,
  ) {}

  public async markOnline(state: OnlineSessionState, ttlSeconds: number): Promise<void> {
    await this.cache.set(this.key(state.sessionId), JSON.stringify({
      session_id: state.sessionId,
      license_id: state.licenseId,
      device_id: state.deviceId,
      activation_id: state.activationId,
      last_heartbeat_at: state.lastHeartbeatAt.toISOString(),
      sequence: state.sequence,
    }), ttlSeconds);
  }

  public async remove(sessionId: string): Promise<void> {
    await this.cache.delete(this.key(sessionId));
  }

  public async removeMany(sessionIds: readonly string[]): Promise<void> {
    await Promise.all(sessionIds.map((sessionId) => this.remove(sessionId)));
  }

  private key(sessionId: string): string {
    return `${this.keyPrefix}online-session:${sessionId}`;
  }
}

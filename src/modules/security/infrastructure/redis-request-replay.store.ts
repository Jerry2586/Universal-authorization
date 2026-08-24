import type { KeyValueCache } from '../../../infrastructure/cache/key-value-cache.js';
import type { RequestReplayStore } from '../request-replay.store.js';

export class RedisRequestReplayStore implements RequestReplayStore {
  public constructor(private readonly cache: KeyValueCache, private readonly keyPrefix: string) {}

  public async claim(input: { deviceId: string; clientNonce: string; requestHash: string; ttlSeconds: number }): Promise<boolean> {
    return this.cache.setIfAbsent(
      `${this.keyPrefix}request-replay:${input.deviceId}:${input.clientNonce}`,
      input.requestHash,
      input.ttlSeconds,
    );
  }
}

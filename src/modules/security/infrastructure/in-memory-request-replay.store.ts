import type { RequestReplayStore } from '../request-replay.store.js';

export class InMemoryRequestReplayStore implements RequestReplayStore {
  private readonly entries = new Map<string, number>();

  public constructor(private readonly clock: () => Date = () => new Date()) {}

  public async claim(input: { deviceId: string; clientNonce: string; requestHash: string; ttlSeconds: number }): Promise<boolean> {
    const now = this.clock().getTime();
    const key = `${input.deviceId}:${input.clientNonce}`;
    const expiresAt = this.entries.get(key);
    if (expiresAt !== undefined && expiresAt > now) return false;
    this.entries.set(key, now + input.ttlSeconds * 1_000);
    return true;
  }
}

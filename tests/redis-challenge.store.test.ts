import { describe, expect, it } from 'vitest';
import type { KeyValueCache } from '../src/infrastructure/cache/key-value-cache.js';
import { RedisChallengeStore } from '../src/modules/challenges/infrastructure/redis-challenge.store.js';

class FakeCache implements KeyValueCache {
  public async get(_key: string): Promise<string | null> { return null; }
  public async incrementWithTtl(_key: string, _ttlSeconds: number): Promise<number> { return 1; }
  private readonly values = new Map<string, string>();

  public async connect(): Promise<void> {}
  public async close(): Promise<void> {}
  public async ping(): Promise<number> {
    return 0;
  }

  public async set(key: string, value: string, _ttlSeconds: number): Promise<void> {
    this.values.set(key, value);
  }

  public async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  public async setIfAbsent(
    key: string,
    value: string,
    _ttlSeconds: number,
  ): Promise<boolean> {
    if (this.values.has(key)) {
      return false;
    }

    this.values.set(key, value);
    return true;
  }

  public async getAndDelete(key: string): Promise<string | null> {
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    return value;
  }
}

describe('RedisChallengeStore', () => {
  it('serializes a challenge and consumes it exactly once', async () => {
    const store = new RedisChallengeStore(new FakeCache(), 'test:');
    const challenge = {
      serverNonce: 'server-nonce',
      productCode: 'demo-product',
      clientNonce: 'client-nonce-123456',
      issuedAt: new Date('2026-08-24T10:00:00.000Z'),
      expiresAt: new Date('2026-08-24T10:02:00.000Z'),
    };

    await store.save(challenge);

    await expect(
      store.consume('server-nonce', new Date('2026-08-24T10:01:00.000Z')),
    ).resolves.toEqual(challenge);
    await expect(
      store.consume('server-nonce', new Date('2026-08-24T10:01:00.000Z')),
    ).resolves.toBeNull();
  });

  it('rejects a challenge that is expired when consumed', async () => {
    const store = new RedisChallengeStore(new FakeCache(), 'test:');

    await store.save({
      serverNonce: 'expired-nonce',
      productCode: 'demo-product',
      clientNonce: 'client-nonce-123456',
      issuedAt: new Date('2026-08-24T10:00:00.000Z'),
      expiresAt: new Date('2026-08-24T10:02:00.000Z'),
    });

    await expect(
      store.consume('expired-nonce', new Date('2026-08-24T10:02:00.000Z')),
    ).resolves.toBeNull();
  });
});

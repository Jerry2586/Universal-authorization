import { createClient } from 'redis';
import type { KeyValueCache } from './key-value-cache.js';

export interface RedisCacheOptions {
  url: string;
  connectTimeoutMs: number;
  onError?: (error: Error) => void;
}

export class RedisCache implements KeyValueCache {
  private readonly client;

  public constructor(options: RedisCacheOptions) {
    this.client = createClient({
      url: options.url,
      socket: {
        connectTimeout: options.connectTimeoutMs,
        reconnectStrategy: (retries) =>
          retries >= 5
            ? new Error('Redis reconnect limit reached')
            : Math.min(retries * 100, 3_000),
      },
    });

    this.client.on('error', (error) => {
      options.onError?.(error);
    });
  }

  public async connect(): Promise<void> {
    if (!this.client.isOpen) await this.client.connect();
  }

  public async close(): Promise<void> {
    if (this.client.isOpen) await this.client.quit();
  }

  public async ping(): Promise<number> {
    const startedAt = performance.now();
    await this.client.ping();
    return Math.round((performance.now() - startedAt) * 100) / 100;
  }

  public async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  public async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.set(key, value, { EX: ttlSeconds });
  }

  public async delete(key: string): Promise<void> {
    await this.client.del(key);
  }

  public async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.client.set(key, value, { EX: ttlSeconds, NX: true });
    return result === 'OK';
  }

  public async getAndDelete(key: string): Promise<string | null> {
    return this.client.getDel(key);
  }

  public async incrementWithTtl(key: string, ttlSeconds: number): Promise<number> {
    const value = await this.client.incr(key);
    if (value === 1) await this.client.expire(key, ttlSeconds);
    return value;
  }
}

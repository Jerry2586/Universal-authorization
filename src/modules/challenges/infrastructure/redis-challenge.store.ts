import { AppError } from '../../../shared/errors/app-error.js';
import type { KeyValueCache } from '../../../infrastructure/cache/key-value-cache.js';
import type { ChallengeStore } from '../challenge.store.js';
import type { Challenge } from '../domain/challenge.js';

interface StoredChallenge {
  serverNonce: string;
  productCode: string;
  clientNonce: string;
  issuedAt: string;
  expiresAt: string;
}

export class RedisChallengeStore implements ChallengeStore {
  public constructor(
    private readonly cache: KeyValueCache,
    private readonly keyPrefix: string,
  ) {}

  public async save(challenge: Challenge): Promise<void> {
    const ttlSeconds = Math.max(
      1,
      Math.ceil((challenge.expiresAt.getTime() - challenge.issuedAt.getTime()) / 1_000),
    );
    const stored: StoredChallenge = {
      serverNonce: challenge.serverNonce,
      productCode: challenge.productCode,
      clientNonce: challenge.clientNonce,
      issuedAt: challenge.issuedAt.toISOString(),
      expiresAt: challenge.expiresAt.toISOString(),
    };

    const saved = await this.cache.setIfAbsent(
      this.key(challenge.serverNonce),
      JSON.stringify(stored),
      ttlSeconds,
    );

    if (!saved) {
      throw new AppError({
        code: 'SERVICE_TEMPORARILY_UNAVAILABLE',
        message: '挑战值生成冲突，请重新请求',
        statusCode: 503,
        retryable: true,
      });
    }
  }

  public async consume(serverNonce: string, now: Date): Promise<Challenge | null> {
    const value = await this.cache.getAndDelete(this.key(serverNonce));

    if (value === null) {
      return null;
    }

    const stored = JSON.parse(value) as StoredChallenge;
    const challenge: Challenge = {
      serverNonce: stored.serverNonce,
      productCode: stored.productCode,
      clientNonce: stored.clientNonce,
      issuedAt: new Date(stored.issuedAt),
      expiresAt: new Date(stored.expiresAt),
    };

    if (challenge.expiresAt.getTime() <= now.getTime()) {
      return null;
    }

    return challenge;
  }

  public async deleteExpired(_now: Date): Promise<number> {
    return 0;
  }

  private key(serverNonce: string): string {
    return `${this.keyPrefix}challenge:${serverNonce}`;
  }
}

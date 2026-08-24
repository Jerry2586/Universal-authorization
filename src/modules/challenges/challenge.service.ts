import { randomBytes } from 'node:crypto';
import type { ChallengeStore } from './challenge.store.js';
import type { Challenge, IssuedChallenge } from './domain/challenge.js';

export type Clock = () => Date;

export class ChallengeService {
  public constructor(
    private readonly store: ChallengeStore,
    private readonly ttlSeconds: number,
    private readonly clock: Clock = () => new Date(),
  ) {}

  public async issue(input: {
    productCode: string;
    clientNonce: string;
  }): Promise<IssuedChallenge> {
    const issuedAt = this.clock();
    const expiresAt = new Date(issuedAt.getTime() + this.ttlSeconds * 1_000);
    const serverNonce = randomBytes(32).toString('base64url');

    const challenge: Challenge = {
      serverNonce,
      productCode: input.productCode,
      clientNonce: input.clientNonce,
      issuedAt,
      expiresAt,
    };

    await this.store.save(challenge);

    return {
      serverNonce,
      issuedAt,
      expiresAt,
      protocolVersion: 'v1',
    };
  }

  public async consume(serverNonce: string): Promise<Challenge | null> {
    return this.store.consume(serverNonce, this.clock());
  }
}

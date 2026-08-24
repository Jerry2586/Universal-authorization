import type { ChallengeStore } from '../challenge.store.js';
import type { Challenge } from '../domain/challenge.js';

export class InMemoryChallengeStore implements ChallengeStore {
  private readonly challenges = new Map<string, Challenge>();

  public async save(challenge: Challenge): Promise<void> {
    this.challenges.set(challenge.serverNonce, challenge);
  }

  public async consume(serverNonce: string, now: Date): Promise<Challenge | null> {
    const challenge = this.challenges.get(serverNonce);

    if (challenge === undefined) {
      return null;
    }

    this.challenges.delete(serverNonce);

    if (challenge.expiresAt.getTime() <= now.getTime()) {
      return null;
    }

    return challenge;
  }

  public async deleteExpired(now: Date): Promise<number> {
    let deleted = 0;

    for (const [serverNonce, challenge] of this.challenges.entries()) {
      if (challenge.expiresAt.getTime() <= now.getTime()) {
        this.challenges.delete(serverNonce);
        deleted += 1;
      }
    }

    return deleted;
  }
}

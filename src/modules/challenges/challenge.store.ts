import type { Challenge } from './domain/challenge.js';

export interface ChallengeStore {
  save(challenge: Challenge): Promise<void>;
  consume(serverNonce: string, now: Date): Promise<Challenge | null>;
  deleteExpired(now: Date): Promise<number>;
}

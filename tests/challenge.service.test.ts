import { describe, expect, it } from 'vitest';
import { ChallengeService } from '../src/modules/challenges/challenge.service.js';
import { InMemoryChallengeStore } from '../src/modules/challenges/infrastructure/in-memory-challenge.store.js';

describe('ChallengeService', () => {
  it('allows a valid challenge to be consumed exactly once', async () => {
    const now = new Date('2026-08-24T10:00:00.000Z');
    const store = new InMemoryChallengeStore();
    const service = new ChallengeService(store, 120, () => now);

    const issued = await service.issue({
      productCode: 'demo-product',
      clientNonce: 'client-generated-nonce-123456',
    });

    const firstConsume = await service.consume(issued.serverNonce);
    const secondConsume = await service.consume(issued.serverNonce);

    expect(firstConsume).toMatchObject({
      productCode: 'demo-product',
      clientNonce: 'client-generated-nonce-123456',
    });
    expect(secondConsume).toBeNull();
  });

  it('rejects an expired challenge', async () => {
    let now = new Date('2026-08-24T10:00:00.000Z');
    const store = new InMemoryChallengeStore();
    const service = new ChallengeService(store, 120, () => now);

    const issued = await service.issue({
      productCode: 'demo-product',
      clientNonce: 'client-generated-nonce-123456',
    });

    now = new Date('2026-08-24T10:02:00.001Z');

    await expect(service.consume(issued.serverNonce)).resolves.toBeNull();
  });
});

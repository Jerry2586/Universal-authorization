import { describe, expect, it } from 'vitest';
import { InMemoryRequestReplayStore } from '../src/modules/security/infrastructure/in-memory-request-replay.store.js';

describe('RequestReplayStore', () => {
  it('accepts a device nonce once and accepts it again only after TTL expiry', async () => {
    let now = new Date('2026-08-24T12:00:00.000Z');
    const store = new InMemoryRequestReplayStore(() => now);
    const input = { deviceId: 'device', clientNonce: 'nonce', requestHash: 'hash', ttlSeconds: 300 };
    await expect(store.claim(input)).resolves.toBe(true);
    await expect(store.claim(input)).resolves.toBe(false);
    now = new Date('2026-08-24T12:05:01.000Z');
    await expect(store.claim(input)).resolves.toBe(true);
  });
});

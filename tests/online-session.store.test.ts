import { describe, expect, it } from 'vitest';
import { InMemoryOnlineSessionStore } from '../src/modules/sessions/infrastructure/in-memory-online-session.store.js';

describe('InMemoryOnlineSessionStore', () => {
  it('expires online state by TTL and removes many session keys', async () => {
    let now = new Date('2026-08-24T12:00:00.000Z');
    const store = new InMemoryOnlineSessionStore(() => now);
    const state = { sessionId: 'session-1', licenseId: 'license-1', deviceId: 'device-1', activationId: 'activation-1', lastHeartbeatAt: now, sequence: 1 };
    await store.markOnline(state, 10);
    expect(store.get('session-1')).toMatchObject({ sequence: 1 });
    await store.markOnline({ ...state, sessionId: 'session-2' }, 10);
    await store.removeMany(['session-1', 'session-2']);
    expect(store.get('session-1')).toBeUndefined();
    expect(store.get('session-2')).toBeUndefined();
    await store.markOnline(state, 10);
    now = new Date('2026-08-24T12:00:10.000Z');
    expect(store.get('session-1')).toBeUndefined();
  });
});

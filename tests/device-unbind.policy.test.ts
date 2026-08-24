import { describe, expect, it } from 'vitest';
import { assertSelfUnbindPolicy } from '../src/modules/devices/device-unbind.policy.js';

const activatedAt = new Date('2026-08-24T10:00:00.000Z');

describe('self-unbind policy', () => {
  it('rejects a key that has not enabled self-unbind', () => {
    expect(() => assertSelfUnbindPolicy({ allowSelfUnbind: false, activatedAt, cooldownSeconds: 0, now: activatedAt }))
      .toThrowError(expect.objectContaining({ code: 'SELF_UNBIND_NOT_ALLOWED' }));
  });

  it('returns the exact available time while cooldown is active', () => {
    try {
      assertSelfUnbindPolicy({ allowSelfUnbind: true, activatedAt, cooldownSeconds: 3600, now: new Date('2026-08-24T10:30:00.000Z') });
      throw new Error('expected policy rejection');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'UNBIND_COOLDOWN_ACTIVE', retryable: true,
        details: { available_at: '2026-08-24T11:00:00.000Z', remaining_seconds: 1800 },
      });
    }
  });

  it('allows unbind exactly at the cooldown boundary', () => {
    expect(() => assertSelfUnbindPolicy({
      allowSelfUnbind: true, activatedAt, cooldownSeconds: 3600, now: new Date('2026-08-24T11:00:00.000Z'),
    })).not.toThrow();
  });
});

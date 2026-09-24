import { DomainError } from '../../../../../packages/core/src/errors.js';

export function createRateLimiter() {
  const buckets = new Map();
  return function rateLimit(key, limit, windowMs) {
    const now = Date.now();
    const current = buckets.get(key);
    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return;
    }
    current.count += 1;
    if (current.count > limit) throw new DomainError('RATE_LIMITED', '请求过于频繁，请稍后再试', 429);
  };
}

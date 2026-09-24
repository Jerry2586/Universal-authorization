export function publicCorsHeaders(request) {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const releaseFeed = pathname === '/api/v1/releases/latest';
  const publicWrite = new Set([
    '/api/v1/installation-challenges', '/api/v1/install-unlocks', '/api/v1/activations',
    '/api/v1/activations/refresh', '/api/v1/product-migrations', '/api/v1/product-migrations/accept',
  ]);
  if (!releaseFeed && !publicWrite.has(pathname)) return {};
  const origin = request.headers.origin;
  if (!origin) return {};
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol)) return {};
  } catch {
    return {};
  }
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': releaseFeed ? 'GET, OPTIONS' : 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-request-id, idempotency-key',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

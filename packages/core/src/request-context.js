import { randomUUID } from 'node:crypto';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export function createRequestContext(request) {
  const supplied = String(request.headers['x-request-id'] ?? '').trim();
  return Object.freeze({
    requestId: REQUEST_ID_PATTERN.test(supplied) ? supplied : randomUUID(),
    startedAt: Date.now(),
  });
}

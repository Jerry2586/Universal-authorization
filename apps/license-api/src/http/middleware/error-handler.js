import { DomainError } from '../../../../../packages/core/src/errors.js';

export function respondError({ response, error, requestId, respondJson, headers = {} }) {
  const known = error instanceof DomainError;
  if (!known) console.error(`[${requestId}]`, error);
  respondJson(response, known ? error.status : 500, {
    error: {
      code: known ? error.code : 'INTERNAL_ERROR',
      message: known ? error.message : '服务内部错误',
      request_id: requestId,
      ...(known && error.details ? { details: error.details } : {}),
    },
  }, headers);
}

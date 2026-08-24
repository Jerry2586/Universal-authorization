import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../errors/app-error.js';
import { failureResponse } from './api-response.js';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send(
      failureResponse({
        requestId: request.id,
        code: 'ROUTE_NOT_FOUND',
        message: '请求的接口不存在',
      }),
    );
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send(
        failureResponse({
          requestId: request.id,
          code: 'INVALID_REQUEST',
          message: '请求参数不符合协议要求',
          details: {
            issues: error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          },
        }),
      );
    }

    if (error instanceof AppError) {
      return reply.status(error.statusCode).send(
        failureResponse({
          requestId: request.id,
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          ...(error.details === undefined ? {} : { details: error.details }),
        }),
      );
    }

    request.log.error({ error }, 'Unhandled request error');

    return reply.status(500).send(
      failureResponse({
        requestId: request.id,
        code: 'INTERNAL_SERVER_ERROR',
        message: '服务器内部错误',
        retryable: true,
      }),
    );
  });
}

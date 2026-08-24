import type { FastifyInstance } from 'fastify';
import type { ReadinessCheck } from '../../shared/health/readiness.js';
import {
  failureResponse,
  successResponse,
} from '../../shared/http/api-response.js';

export function registerHealthRoutes(
  app: FastifyInstance,
  readinessCheck?: ReadinessCheck,
): void {
  app.get('/health', async (request) => {
    return successResponse(
      request.id,
      {
        status: 'healthy',
        service: 'universal-license-server',
        version: '0.8.0',
      },
      '服务运行正常',
    );
  });

  app.get('/ready', async (request, reply) => {
    if (readinessCheck === undefined) {
      return successResponse(
        request.id,
        {
          status: 'ready',
          components: {},
        },
        '服务已就绪',
      );
    }

    const report = await readinessCheck();

    if (!report.ready) {
      return reply.status(503).send(
        failureResponse({
          requestId: request.id,
          code: 'SERVICE_TEMPORARILY_UNAVAILABLE',
          message: '基础设施尚未就绪',
          retryable: true,
          details: {
            components: report.components,
          },
        }),
      );
    }

    return successResponse(
      request.id,
      {
        status: 'ready',
        components: report.components,
      },
      '服务已就绪',
    );
  });
}






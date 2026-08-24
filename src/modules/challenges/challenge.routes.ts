import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { successResponse } from '../../shared/http/api-response.js';
import type { ChallengeService } from './challenge.service.js';

const issueChallengeSchema = z.object({
  product_code: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, '产品编码格式无效'),
  client_nonce: z.string().min(16).max(128),
});

export function registerChallengeRoutes(
  app: FastifyInstance,
  challengeService: ChallengeService,
): void {
  app.post('/api/v1/challenges', async (request, reply) => {
    const input = issueChallengeSchema.parse(request.body);
    const challenge = await challengeService.issue({
      productCode: input.product_code,
      clientNonce: input.client_nonce,
    });

    return reply.status(201).send(
      successResponse(
        request.id,
        {
          server_nonce: challenge.serverNonce,
          issued_at: challenge.issuedAt.toISOString(),
          expires_at: challenge.expiresAt.toISOString(),
          protocol_version: challenge.protocolVersion,
        },
        '挑战值签发成功',
        challenge.issuedAt,
      ),
    );
  });
}

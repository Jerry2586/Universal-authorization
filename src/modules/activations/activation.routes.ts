import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../shared/errors/app-error.js';
import { successResponse } from '../../shared/http/api-response.js';
import type { ActivationService } from './activation.service.js';

const productCode = z.string().trim().min(3).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/);
const clientNonce = z.string().min(16).max(128);
const idempotencyKey = z.string().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const timestamp = z.string().datetime({ offset: true });

const activationBodySchema = z.object({
  product_code: productCode,
  license_key: z.string().trim().toUpperCase().regex(/^ULK1(?:-[A-HJ-NP-Z2-9]{4}){5}$/),
  device_public_key: z.string().min(80).max(4_096),
  device_fingerprint_hash: z.string().regex(/^[A-Fa-f0-9]{64}$/),
  device_name: z.string().trim().min(1).max(120).optional(),
  platform: z.string().trim().toLowerCase().min(2).max(32).regex(/^[a-z0-9._-]+$/),
  os_version: z.string().trim().min(1).max(128).optional(),
  client_version: z.string().trim().min(1).max(64),
  server_nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  client_nonce: clientNonce,
  timestamp,
  idempotency_key: idempotencyKey,
}).strict();

const activationHeaderSchema = z.object({
  productCode,
  clientVersion: z.string().trim().min(1).max(64),
  timestamp,
  clientNonce,
  deviceKeyId: z.string().trim().min(1).max(96).regex(/^[A-Za-z0-9._:-]+$/),
  signature: z.string().min(80).max(128).regex(/^[A-Za-z0-9_-]+$/),
  idempotencyKey,
});

export function registerActivationRoutes(app: FastifyInstance, service: ActivationService): void {
  app.post('/api/v1/licenses/activate', async (request, reply) => {
    const body = activationBodySchema.parse(request.body);
    const headers = activationHeaderSchema.parse({
      productCode: firstHeader(request.headers['x-product-code']),
      clientVersion: firstHeader(request.headers['x-client-version']),
      timestamp: firstHeader(request.headers['x-timestamp']),
      clientNonce: firstHeader(request.headers['x-client-nonce']),
      deviceKeyId: firstHeader(request.headers['x-key-id']),
      signature: firstHeader(request.headers['x-signature']),
      idempotencyKey: firstHeader(request.headers['idempotency-key']),
    });

    requireEqual('产品编码', headers.productCode, body.product_code);
    requireEqual('客户端版本', headers.clientVersion, body.client_version);
    requireEqual('时间戳', headers.timestamp, body.timestamp);
    requireEqual('客户端随机数', headers.clientNonce, body.client_nonce);
    requireEqual('幂等键', headers.idempotencyKey, body.idempotency_key);

    const result = await service.activate({
      product_code: body.product_code,
      license_key: body.license_key,
      device_public_key: body.device_public_key,
      device_fingerprint_hash: body.device_fingerprint_hash,
      ...(body.device_name === undefined ? {} : { device_name: body.device_name }),
      platform: body.platform,
      ...(body.os_version === undefined ? {} : { os_version: body.os_version }),
      client_version: body.client_version,
      server_nonce: body.server_nonce,
      client_nonce: body.client_nonce,
      timestamp: body.timestamp,
      idempotency_key: body.idempotency_key,
      deviceKeyId: headers.deviceKeyId,
      signature: headers.signature,
      requestId: request.id,
      ipAddress: request.ip,
    });
    return reply.status(201).send(successResponse(request.id, result, '授权激活成功', new Date(result.issued_at)));
  });
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requireEqual(name: string, header: string, body: string): void {
  if (header !== body) {
    throw new AppError({ code: 'INVALID_REQUEST', message: `${name}请求头与请求体不一致`, statusCode: 400 });
  }
}



import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../shared/errors/app-error.js';
import { successResponse } from '../../shared/http/api-response.js';
import type { DeviceUnbindService } from '../devices/device-unbind.service.js';
import type { SessionHeartbeatService } from './session-heartbeat.service.js';
import type { SessionReleaseService } from './session-release.service.js';

const productCode = z.string().trim().min(3).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/);
const clientVersion = z.string().trim().min(1).max(64);
const clientNonce = z.string().min(16).max(128);
const timestamp = z.string().datetime({ offset: true });
const idempotencyKey = z.string().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const deviceId = z.uuid();
const deviceKeyId = z.string().trim().min(1).max(96).regex(/^[A-Za-z0-9._:-]+$/);
const signature = z.string().min(80).max(128).regex(/^[A-Za-z0-9_-]+$/);
const compactToken = z.string().min(80).max(32_768);

const commonBodySchema = z.object({
  device_certificate: compactToken,
  license_token: compactToken,
  client_version: clientVersion,
  timestamp,
  client_nonce: clientNonce,
});
const heartbeatBodySchema = commonBodySchema.extend({ sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
const releaseBodySchema = commonBodySchema.extend({ idempotency_key: idempotencyKey }).strict();
const unbindBodySchema = commonBodySchema.extend({
  idempotency_key: idempotencyKey,
  reason: z.literal('USER_REQUEST'),
}).strict();
const commonHeadersSchema = z.object({ productCode, clientVersion, timestamp, clientNonce, deviceId, deviceKeyId, signature });

export function registerSessionLifecycleRoutes(
  app: FastifyInstance,
  heartbeatService: SessionHeartbeatService,
  releaseService: SessionReleaseService,
  unbindService: DeviceUnbindService,
): void {
  app.post('/api/v1/sessions/heartbeat', async (request) => {
    const body = heartbeatBodySchema.parse(request.body);
    const headers = commonHeadersSchema.parse(readHeaders(request.headers));
    requireCommonHeaders(headers, body);
    const signingBody = {
      device_certificate: body.device_certificate, license_token: body.license_token,
      client_version: body.client_version, timestamp: body.timestamp, client_nonce: body.client_nonce,
      sequence: body.sequence,
    };
    const result = await heartbeatService.heartbeat({
      productCode: headers.productCode, clientVersion: body.client_version, timestamp: body.timestamp,
      clientNonce: body.client_nonce, deviceId: headers.deviceId, deviceKeyId: headers.deviceKeyId,
      signature: headers.signature, body: signingBody, deviceCertificate: body.device_certificate,
      licenseToken: body.license_token, sequence: body.sequence, requestId: request.id, ipAddress: request.ip,
    });
    return successResponse(request.id, result, '会话心跳成功', new Date(result.heartbeat_at));
  });

  app.post('/api/v1/sessions/release', async (request) => {
    const body = releaseBodySchema.parse(request.body);
    const headers = commonHeadersSchema.extend({ idempotencyKey }).parse({
      ...readHeaders(request.headers), idempotencyKey: firstHeader(request.headers['idempotency-key']),
    });
    requireCommonHeaders(headers, body);
    requireEqual('幂等键', headers.idempotencyKey, body.idempotency_key);
    const signingBody = {
      device_certificate: body.device_certificate, license_token: body.license_token,
      client_version: body.client_version, timestamp: body.timestamp, client_nonce: body.client_nonce,
      idempotency_key: body.idempotency_key,
    };
    const result = await releaseService.release({
      productCode: headers.productCode, clientVersion: body.client_version, timestamp: body.timestamp,
      clientNonce: body.client_nonce, deviceId: headers.deviceId, deviceKeyId: headers.deviceKeyId,
      idempotencyKey: body.idempotency_key, signature: headers.signature, body: signingBody,
      deviceCertificate: body.device_certificate, licenseToken: body.license_token,
      requestId: request.id, ipAddress: request.ip,
    });
    return successResponse(request.id, result, '授权会话已主动释放', new Date(result.released_at));
  });

  app.post('/api/v1/devices/unbind', async (request) => {
    const body = unbindBodySchema.parse(request.body);
    const headers = commonHeadersSchema.extend({ idempotencyKey }).parse({
      ...readHeaders(request.headers), idempotencyKey: firstHeader(request.headers['idempotency-key']),
    });
    requireCommonHeaders(headers, body);
    requireEqual('幂等键', headers.idempotencyKey, body.idempotency_key);
    const signingBody = {
      device_certificate: body.device_certificate, license_token: body.license_token,
      client_version: body.client_version, timestamp: body.timestamp, client_nonce: body.client_nonce,
      idempotency_key: body.idempotency_key, reason: body.reason,
    };
    const result = await unbindService.unbind({
      productCode: headers.productCode, clientVersion: body.client_version, timestamp: body.timestamp,
      clientNonce: body.client_nonce, deviceId: headers.deviceId, deviceKeyId: headers.deviceKeyId,
      idempotencyKey: body.idempotency_key, signature: headers.signature, body: signingBody,
      deviceCertificate: body.device_certificate, licenseToken: body.license_token, reason: body.reason,
      requestId: request.id, ipAddress: request.ip,
    });
    return successResponse(request.id, result, '设备已自助解绑', new Date(result.unbound_at));
  });
}

function readHeaders(headers: Record<string, string | string[] | undefined>) {
  return {
    productCode: firstHeader(headers['x-product-code']), clientVersion: firstHeader(headers['x-client-version']),
    timestamp: firstHeader(headers['x-timestamp']), clientNonce: firstHeader(headers['x-client-nonce']),
    deviceId: firstHeader(headers['x-device-id']), deviceKeyId: firstHeader(headers['x-key-id']),
    signature: firstHeader(headers['x-signature']),
  };
}

function requireCommonHeaders(
  headers: { clientVersion: string; timestamp: string; clientNonce: string },
  body: { client_version: string; timestamp: string; client_nonce: string },
): void {
  requireEqual('客户端版本', headers.clientVersion, body.client_version);
  requireEqual('时间戳', headers.timestamp, body.timestamp);
  requireEqual('客户端随机数', headers.clientNonce, body.client_nonce);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requireEqual(name: string, header: string, body: string): void {
  if (header !== body) throw new AppError({ code: 'INVALID_REQUEST', message: `${name}请求头与请求体不一致`, statusCode: 400 });
}

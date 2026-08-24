import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app !== undefined) {
    await app.close();
    app = undefined;
  }
});

describe('HTTP application', () => {
  it('returns a healthy status using the common response envelope', async () => {
    app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: {
        'x-request-id': 'test-request-health',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      request_id: 'test-request-health',
      success: true,
      code: 'OK',
      message: '服务运行正常',
      data: {
        status: 'healthy',
        service: 'universal-license-server',
        version: '0.8.0',
      },
    });
  });

  it('issues a short-lived one-time challenge', async () => {
    const now = new Date('2026-08-24T10:00:00.000Z');
    app = buildApp({
      challengeTtlSeconds: 120,
      clock: () => now,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/challenges',
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'test-request-challenge',
      },
      payload: {
        product_code: 'demo-product',
        client_nonce: 'client-generated-nonce-123456',
      },
    });

    expect(response.statusCode).toBe(201);

    const body = response.json();
    expect(body).toMatchObject({
      request_id: 'test-request-challenge',
      success: true,
      code: 'OK',
      server_time: '2026-08-24T10:00:00.000Z',
      data: {
        issued_at: '2026-08-24T10:00:00.000Z',
        expires_at: '2026-08-24T10:02:00.000Z',
        protocol_version: 'v1',
      },
    });
    expect(body.data.server_nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('rejects a malformed challenge request with a standard error', async () => {
    app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/challenges',
      payload: {
        product_code: 'INVALID PRODUCT CODE',
        client_nonce: 'short',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      code: 'INVALID_REQUEST',
      message: '请求参数不符合协议要求',
      data: {
        retryable: false,
      },
    });
  });

  it('returns a standard response for an unknown route', async () => {
    app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/missing',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      success: false,
      code: 'ROUTE_NOT_FOUND',
      data: {
        retryable: false,
      },
    });
  });
});







import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe('readiness endpoint', () => {
  it('reports ready when PostgreSQL and Redis are available', async () => {
    const app = buildApp({
      readinessCheck: async () => ({
        ready: true,
        components: {
          postgresql: { status: 'up', latencyMs: 1.2 },
          redis: { status: 'up', latencyMs: 0.8 },
        },
      }),
    });

    const response = await app.inject({ method: 'GET', url: '/ready' });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      code: 'OK',
      data: {
        status: 'ready',
        components: {
          postgresql: { status: 'up' },
          redis: { status: 'up' },
        },
      },
    });
  });

  it('returns 503 when an infrastructure dependency is down', async () => {
    const app = buildApp({
      readinessCheck: async () => ({
        ready: false,
        components: {
          postgresql: { status: 'up', latencyMs: 1.2 },
          redis: { status: 'down', latencyMs: 5, message: 'connection refused' },
        },
      }),
    });

    const response = await app.inject({ method: 'GET', url: '/ready' });
    await app.close();

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      success: false,
      code: 'SERVICE_TEMPORARILY_UNAVAILABLE',
      data: {
        retryable: true,
        details: {
          components: {
            redis: { status: 'down' },
          },
        },
      },
    });
  });
});

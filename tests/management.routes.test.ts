import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { AdminPrincipalResolver } from '../src/modules/identity/admin-principal.js';
import { PERMISSIONS } from '../src/modules/identity/domain/permissions.js';
import type { ProductManagementService } from '../src/modules/products/product-management.service.js';
import type { LicenseManagementService } from '../src/modules/licenses/license-management.service.js';

let app: FastifyInstance | undefined;
afterEach(async () => { if (app !== undefined) { await app.close(); app = undefined; } });

const product = {
  id: '33333333-3333-4333-8333-333333333333', tenantId: '11111111-1111-4111-8111-111111111111', code: 'designer-pro',
  name: '设计软件', description: null, status: 'ACTIVE' as const, minimumClientVersion: null, recommendedClientVersion: null,
  forceUpdateVersion: null, settings: {}, createdAt: new Date('2026-08-24T00:00:00Z'), updatedAt: new Date('2026-08-24T00:00:00Z'),
};

describe('management routes', () => {
  it('checks RBAC before executing product management', async () => {
    app = buildApp({ management: dependencies(new Set()) });
    const response = await app.inject({ method: 'POST', url: '/admin/v1/products', headers: adminHeaders(), payload: { code: 'designer-pro', name: '设计软件' } });
    expect(response.statusCode).toBe(403); expect(response.json()).toMatchObject({ success: false, code: 'ADMIN_FORBIDDEN' });
  });

  it('creates a product through the separated admin API', async () => {
    app = buildApp({ management: dependencies(new Set([PERMISSIONS.PRODUCTS_WRITE])) });
    const response = await app.inject({ method: 'POST', url: '/admin/v1/products', headers: adminHeaders(), payload: { code: 'designer-pro', name: '设计软件' } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ success: true, data: { id: product.id, code: 'designer-pro', status: 'ACTIVE' } });
  });

  it('returns database totals for product and policy pagination', async () => {
    app = buildApp({
      management: dependencies(new Set([PERMISSIONS.PRODUCTS_READ, PERMISSIONS.LICENSES_READ]), {
        listProducts: async () => ({ items: [product], total: 37 }),
        listPolicies: async () => ({ items: [], total: 12 }),
      }),
    });

    const productsResponse = await app.inject({
      method: 'GET',
      url: '/admin/v1/products?limit=20&offset=20',
      headers: adminHeaders(),
    });
    expect(productsResponse.statusCode).toBe(200);
    expect(productsResponse.json()).toMatchObject({
      success: true,
      data: { items: [{ id: product.id }], total: 37, limit: 20, offset: 20 },
    });

    const policiesResponse = await app.inject({
      method: 'GET',
      url: '/admin/v1/license-policies?limit=10&offset=10',
      headers: adminHeaders(),
    });
    expect(policiesResponse.statusCode).toBe(200);
    expect(policiesResponse.json()).toMatchObject({
      success: true,
      data: { items: [], total: 12, limit: 10, offset: 10 },
    });
  });

  it('keeps client modules disabled when their dependencies are not supplied', async () => {
    app = buildApp({ management: dependencies(new Set([PERMISSIONS.LICENSES_WRITE])) });
    for (const url of ['/api/v1/activate', '/api/v1/licenses/verify', '/api/v1/heartbeat', '/admin/v1/tokens']) {
      const response = await app.inject({ method: 'POST', url });
      expect(response.statusCode).toBe(404);
    }
  });
});

function dependencies(permissions: ReadonlySet<string>, productOverrides: Record<string, unknown> = {}) {
  const principalResolver: AdminPrincipalResolver = { resolve: async () => ({
    userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', tenantId: '11111111-1111-4111-8111-111111111111', permissions,
  }) };
  const productService = { createProduct: async () => product, ...productOverrides } as unknown as ProductManagementService;
  const licenseService = {} as LicenseManagementService;
  return { principalResolver, productService, licenseService };
}
function adminHeaders() { return { authorization: 'Bearer test', 'x-admin-user-id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }; }


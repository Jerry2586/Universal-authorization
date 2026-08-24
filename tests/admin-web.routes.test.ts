import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';

describe('管理后台静态页面', () => {
  let root = '';
  beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'ua-admin-')); await writeFile(join(root, 'index.html'), '<h1>Admin Console</h1>'); });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });
  it('提供 SPA 首页并保留未知管理 API 的 JSON 404', async () => {
    const app = buildApp({ adminWebRoot: root });
    const page = await app.inject({ method: 'GET', url: '/admin/' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Admin Console');
    const api = await app.inject({ method: 'GET', url: '/admin/v1/not-found' });
    expect(api.statusCode).toBe(404);
    expect(api.json().code).toBe('ROUTE_NOT_FOUND');
    await app.close();
  });
});

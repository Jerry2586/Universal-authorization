import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allEndpoints } from '../web/src/api/catalog.js';

const API_PATH = /^(?:\/api\/v1\/|\/admin\/auth\/|\/admin\/v1\/|\/health$|\/ready$)/;
const ROUTE_DECLARATION = /app\.(get|post|patch|put|delete)(?:<.*?>)?\(\s*['"]([^'"]+)['"]/;

describe('Web 管理后台与服务端路由契约', () => {
  it('接口目录与源码中全部真实 API 路由严格一致', () => {
    const serverRoutes = routeFiles(resolve(process.cwd(), 'src', 'modules'))
      .flatMap((file) => readFileSync(file, 'utf8').split(/\r?\n/))
      .map((line) => line.match(ROUTE_DECLARATION))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => `${match[1]?.toUpperCase()} ${match[2]}`)
      .filter((route) => API_PATH.test(route.slice(route.indexOf(' ') + 1)))
      .sort();

    const catalogRoutes = allEndpoints
      .map((endpoint) => `${endpoint.method} ${endpoint.path}`)
      .sort();

    expect(catalogRoutes).toEqual(serverRoutes);
  });
});

function routeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name.endsWith('.routes.ts') ? [path] : [];
  });
}

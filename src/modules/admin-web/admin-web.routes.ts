import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { failureResponse } from '../../shared/http/api-response.js';

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

export function registerAdminWebRoutes(app: FastifyInstance, rootDirectory: string): void {
  const root = resolve(rootDirectory);
  const indexFile = resolve(root, 'index.html');

  app.get('/admin', async (_request, reply) => reply.redirect('/admin/'));
  app.get<{ Params: { '*': string } }>('/admin/*', async (request, reply) => {
    const requested = request.params['*'];
    if (requested.startsWith('auth/') || requested.startsWith('v1/')) {
      return reply.status(404).send(failureResponse({
        requestId: request.id,
        code: 'ROUTE_NOT_FOUND',
        message: '请求的接口不存在',
      }));
    }

    const candidate = resolve(root, requested || 'index.html');
    const insideRoot = candidate === root || candidate.startsWith(`${root}${sep}`);
    if (!insideRoot) return reply.status(403).send('Forbidden');

    let file = candidate;
    try {
      if (!(await stat(file)).isFile()) file = indexFile;
    } catch {
      file = indexFile;
    }

    try {
      const body = await readFile(file);
      const extension = extname(file).toLowerCase();
      reply.type(contentTypes[extension] ?? 'application/octet-stream');
      reply.header('x-content-type-options', 'nosniff');
      reply.header('cache-control', extension === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable');
      return reply.send(body);
    } catch {
      return reply.status(503).type('text/html; charset=utf-8').send(
        '<!doctype html><meta charset="utf-8"><title>后台尚未构建</title><style>body{font-family:system-ui;background:#07111f;color:#dbeafe;padding:48px}code{color:#67e8f9}</style><h1>Web 管理后台尚未构建</h1><p>请在项目目录执行 <code>pnpm web:build</code> 后重新访问。</p>',
      );
    }
  });
}

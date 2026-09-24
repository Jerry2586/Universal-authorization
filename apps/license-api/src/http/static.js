import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { securityHeaders } from './middleware/response.js';

const PUBLIC_ROOT = resolve(process.cwd(), 'apps/web/public');
const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
});

export function serveStatic(pathname, response, requestId) {
  const routeMap = { '/': 'index.html', '/build': 'build.html', '/admin': 'admin.html' };
  const relative = routeMap[pathname] ?? pathname.replace(/^\/+/, '');
  const file = resolve(PUBLIC_ROOT, relative);
  if (!(file === PUBLIC_ROOT || file.startsWith(`${PUBLIC_ROOT}${sep}`)) || !existsSync(file) || !statSync(file).isFile()) return false;
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  response.writeHead(200, {
    ...securityHeaders(type),
    'cache-control': 'no-store',
    'content-length': statSync(file).size,
    'x-request-id': requestId,
  });
  createReadStream(file).pipe(response);
  return true;
}

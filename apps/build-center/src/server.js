import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createReadStream, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadLocalEnvironment } from '../../license-api/src/config.js';

const root = resolve(process.cwd(), 'apps/web/public');

const files = new Map([
  ['/', ['build.html', 'text/html; charset=utf-8']],
  ['/build', ['build.html', 'text/html; charset=utf-8']],
  ['/assets/site.css', ['assets/site.css', 'text/css; charset=utf-8']],
  ['/assets/portal.js', ['assets/portal.js', 'text/javascript; charset=utf-8']],
]);
const proxyPaths = /^\/web\/(?:customer(?:\/|$)|session$|logout$)/;
const security = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

export function createBuildCenterHandler({ internalUrl = 'http://127.0.0.1:8787', internalToken, publicRoot = root } = {}) {
  if (typeof internalToken !== 'string' || internalToken.length < 32) throw new Error('必须设置至少 32 字符的 INTERNAL_SERVICE_TOKEN');
  const destinationBase = new URL(internalUrl);
  if (!['http:', 'https:'].includes(destinationBase.protocol)) throw new Error('INTERNAL_LICENSE_URL 协议无效');
  return function handler(request, response) {
    let url;
    try { url = new URL(request.url ?? '/', 'http://localhost'); }
    catch { response.writeHead(400, security); response.end(); return; }
    if (request.method === 'GET' && url.pathname === '/health') {
      response.writeHead(200, { ...security, 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: true, service: 'appgog-build-center' }));
      return;
    }
    const file = files.get(url.pathname);
    if (request.method === 'GET' && file) {
      const path = resolve(publicRoot, file[0]);
      try {
        const size = statSync(path).size;
        response.writeHead(200, { ...security, 'content-type': file[1], 'content-length': size, 'cache-control': 'no-store' });
        createReadStream(path).pipe(response);
      } catch { response.writeHead(500, security); response.end(); }
      return;
    }
    if (!['GET', 'POST'].includes(request.method) || !proxyPaths.test(url.pathname)) {
      response.writeHead(404, { ...security, 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: '接口或页面不存在' } }));
      return;
    }
    if ((url.pathname === '/web/session' || url.pathname === '/web/logout') && url.searchParams.get('actor') !== 'customer') {
      response.writeHead(403, { ...security, 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'ACTOR_INVALID', message: '打包中心只允许客户会话' } }));
      return;
    }
    const destination = new URL(url.pathname + url.search, destinationBase);
    const forward = destination.protocol === 'https:' ? httpsRequest : httpRequest;
    const headers = { 'x-appgog-internal': internalToken };
    for (const name of ['cookie', 'content-type', 'content-length', 'x-csrf-token', 'accept']) {
      if (request.headers[name]) headers[name] = request.headers[name];
    }
    const upstream = forward(destination, { method: request.method, headers }, (result) => {
      const allowed = {};
      for (const name of ['content-type', 'content-length', 'content-disposition', 'x-appgog-sha256', 'set-cookie', 'cache-control']) {
        if (result.headers[name] !== undefined) allowed[name] = result.headers[name];
      }
      response.writeHead(result.statusCode ?? 502, { ...security, ...allowed });
      result.pipe(response);
    });
    upstream.on('error', () => {
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(502, { ...security, 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'LICENSE_CENTER_UNAVAILABLE', message: '授权中心暂时不可用' } }));
    });
    request.pipe(upstream);
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.dirname, 'server.js')) {
  const port = Number.parseInt(process.env.BUILD_CENTER_PORT ?? '8788', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('BUILD_CENTER_PORT 无效');
  loadLocalEnvironment();
  createServer(createBuildCenterHandler({ internalUrl: process.env.INTERNAL_LICENSE_URL ?? 'http://127.0.0.1:8787', internalToken: process.env.INTERNAL_SERVICE_TOKEN }))
    .listen(port, () => console.log(`APPGOG Build Center listening on ${port}`));
}

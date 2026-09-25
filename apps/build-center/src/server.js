import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createReadStream, statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadLocalEnvironment } from '../../../packages/core/src/environment.js';
import { clientAddress } from '../../../packages/core/src/client-address.js';
import { createRequestContext } from '../../../packages/core/src/request-context.js';

import { PACKAGE_VERSION, renderVersionedHtml } from '../../../packages/core/src/version.js';

const root = resolve(process.cwd(), 'apps/web/public');
// Explicit customer surface: never expose admin modules or arbitrary publicRoot paths.
const files = new Map([
  ['/', ['build.html', 'text/html; charset=utf-8']],
  ['/build', ['build.html', 'text/html; charset=utf-8']],
  ...['site.css', 'admin-login.css', 'build-center.css', 'portal-design.css'].map(name => [`/assets/${name}`, [`assets/${name}`, 'text/css; charset=utf-8']]),
  ['/assets/favicon.svg', ['assets/favicon.svg', 'image/svg+xml']],
  ['/assets/logo.png', ['assets/logo.png', 'image/png']],
  ...['customer-portal.js', ...['customer-page', 'shell', 'core', 'ui', 'tickets', 'api-client', 'dialog'].map(name => `portal/${name}.js`)]
    .map(name => [`/assets/${name}`, [`assets/${name}`, 'text/javascript; charset=utf-8']]),
]);
const proxyPaths = /^\/web\/(?:customer(?:\/|$)|session$|logout$)/;
const security = {
  'x-appgog-version': PACKAGE_VERSION,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

export function createBuildCenterHandler({
  internalUrl = 'http://127.0.0.1:8787', internalToken, nodeToken, publicRoot = root,
  proxyTimeoutMs = 30_000, healthTimeoutMs = 2_000,
} = {}) {
  if ((!nodeToken || nodeToken.length < 32) && (!internalToken || internalToken.length < 32)) {
    throw new Error('必须设置打包中心节点凭证或至少 32 字符的 INTERNAL_SERVICE_TOKEN');
  }
  const destinationBase = new URL(internalUrl);
  if (!['http:', 'https:'].includes(destinationBase.protocol)) throw new Error('INTERNAL_LICENSE_URL 协议无效');
  const credentials = nodeToken ? { authorization: `Bearer ${nodeToken}` } : { 'x-appgog-internal': internalToken };

  async function readiness(requestId) {
    for (const [file] of files.values()) {
      if (!statSync(resolve(publicRoot, file)).isFile()) throw new Error('Static resource unavailable');
    }
    const signal = AbortSignal.timeout(healthTimeoutMs);
    const options = { headers: { ...credentials, 'x-request-id': requestId }, signal, redirect: 'error' };
    const health = await fetch(new URL('/health', destinationBase), options);
    const healthData = await health.json();
    if (!health.ok || healthData.ok !== true) throw new Error('License center unhealthy');
    if (healthData.version !== PACKAGE_VERSION) {
      const error = new Error('授权中心与打包中心版本不一致，请更新并重启两端');
      error.code = 'VERSION_MISMATCH';
      error.upstreamVersion = healthData.version ?? null;
      throw error;
    }
    // A session-less 401 proves that the internal node credential passed the surface boundary.
    const session = await fetch(new URL('/web/session?actor=customer', destinationBase), options);
    const sessionData = await session.json();
    if (session.status !== 401 || sessionData.error?.code !== 'SESSION_REQUIRED') throw new Error('Node credential rejected');
  }

  return async function handler(request, response) {
    const { requestId } = createRequestContext(request);
    const responseHeaders = { ...security, 'x-request-id': requestId, 'cache-control': 'no-store' };
    const json = (status, body) => {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(status, { ...responseHeaders, 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    const fail = (status, code, message) => json(status, { error: { code, message, request_id: requestId } });
    let url;
    try { url = new URL(request.url ?? '/', 'http://localhost'); }
    catch { fail(400, 'URL_INVALID', '请求地址无效'); return; }
    if (request.method === 'GET' && url.pathname === '/health') {
      try {
        await readiness(requestId);
        json(200, { ok: true, service: 'appgog-build-center', version: PACKAGE_VERSION, upstream_version: PACKAGE_VERSION });
      } catch (error) {
        json(503, { ok: false, service: 'appgog-build-center', version: PACKAGE_VERSION,
          ...(error.code === 'VERSION_MISMATCH' ? { upstream_version: error.upstreamVersion } : {}),
          error: { code: error.code === 'VERSION_MISMATCH' ? error.code : 'BUILD_CENTER_NOT_READY',
            message: error.code === 'VERSION_MISMATCH' ? error.message : '打包中心尚未就绪，请检查静态资源、授权中心和节点凭证', request_id: requestId } });
      }
      return;
    }
    const file = files.get(url.pathname);
    if (request.method === 'GET' && file) {
      const path = resolve(publicRoot, file[0]);
      try {
        const stat = statSync(path);
        if (!stat.isFile()) throw new Error('Not a file');
        if (file[1].startsWith('text/html')) {
          const html = renderVersionedHtml(readFileSync(path, 'utf8'));
          response.writeHead(200, { ...responseHeaders, 'content-type': file[1], 'content-length': html.length });
          response.end(html);
          return;
        }
        const stream = createReadStream(path);
        stream.on('error', () => fail(500, 'STATIC_RESOURCE_UNAVAILABLE', '页面资源不可用'));
        response.on('close', () => stream.destroy());
        stream.once('open', () => {
          response.writeHead(200, { ...responseHeaders, 'content-type': file[1], 'content-length': stat.size });
          stream.pipe(response);
        });
      } catch { fail(500, 'STATIC_RESOURCE_UNAVAILABLE', '页面资源不可用'); }
      return;
    }
    if (!['GET', 'POST'].includes(request.method) || !proxyPaths.test(url.pathname)) {
      fail(404, 'NOT_FOUND', '接口或页面不存在'); return;
    }
    if ((url.pathname === '/web/session' || url.pathname === '/web/logout') && url.searchParams.get('actor') !== 'customer') {
      fail(403, 'ACTOR_INVALID', '打包中心只允许客户会话'); return;
    }
    const destination = new URL(url.pathname + url.search, destinationBase);
    const forward = destination.protocol === 'https:' ? httpsRequest : httpRequest;
    const headers = { ...credentials, 'x-request-id': requestId, 'x-forwarded-for': clientAddress(request) };
    for (const name of ['cookie', 'content-type', 'content-length', 'x-csrf-token', 'accept']) {
      if (request.headers[name]) headers[name] = request.headers[name];
    }
    const upstream = forward(destination, { method: request.method, headers }, (result) => {
      const allowed = {};
      for (const name of ['content-type', 'content-length', 'content-disposition', 'x-appgog-sha256', 'set-cookie', 'cache-control', 'x-request-id', 'retry-after']) {
        if (result.headers[name] !== undefined) allowed[name] = result.headers[name];
      }
      response.writeHead(result.statusCode ?? 502, { ...responseHeaders, ...allowed });
      result.on('error', () => response.destroy());
      result.pipe(response);
    });
    // Socket inactivity timeout allows large uploads/downloads while bounding an unresponsive backend.
    upstream.setTimeout(proxyTimeoutMs, () => {
      fail(504, 'LICENSE_CENTER_TIMEOUT', '授权中心响应超时，请稍后重试');
      upstream.destroy();
    });
    upstream.on('error', () => fail(502, 'LICENSE_CENTER_UNAVAILABLE', '授权中心暂时不可用'));
    request.on('aborted', () => upstream.destroy());
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.dirname, 'server.js')) {
  loadLocalEnvironment();
  const port = Number(process.env.BUILD_CENTER_PORT ?? '8788');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('BUILD_CENTER_PORT 无效');
  createServer(createBuildCenterHandler({
    internalUrl: process.env.INTERNAL_LICENSE_URL ?? `http://127.0.0.1:${process.env.PORT ?? '8787'}`,
    internalToken: process.env.INTERNAL_SERVICE_TOKEN,
    nodeToken: process.env.BUILD_CENTER_NODE_TOKEN,
  }))
    .listen(port, () => console.log(`APPGOG Build Center listening on ${port}`));
}

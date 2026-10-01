import { createServer } from 'node:http';
import { PACKAGE_VERSION } from '../../packages/core/src/version.js';
// Only the standby probe is available until a verified pair is imported.
export function standbyServer() {
  return createServer((request, response) => {
    const health = request.method === 'GET' && request.url === '/health';
    response.writeHead(health ? 200 : 503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify(health
      ? { ok: true, paired: false, service: 'appgog-build-standby', version: PACKAGE_VERSION }
      : { error: { code: 'BUSINESS_PAIR_REQUIRED', message: '打包中心等待授权中心配对' } }));
  });
}

if (process.argv[1] && import.meta.filename === process.argv[1]) standbyServer().listen(8788, '127.0.0.1');

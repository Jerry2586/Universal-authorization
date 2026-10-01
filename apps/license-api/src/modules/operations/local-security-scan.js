import { request as unixRequest } from 'node:http';

// One fixed local action. The browser never chooses a command or path.
export function localSecurityScan(action, env = process.env) {
  if (!['status', 'scan'].includes(action)) throw new TypeError('Unknown security action');
  const socketPath = env.APPGOG_HOST_SCAN_SOCKET || '/app/runtime/host-security/scan.sock';
  return new Promise((resolve) => {
    const req = unixRequest({ socketPath, path: action === 'scan' ? '/scan' : '/status',
      method: action === 'scan' ? 'POST' : 'GET', timeout: 5000,
      headers: action === 'scan' ? { 'Content-Length': '0' } : {} }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (body.length > 16384) req.destroy(new Error('oversized response'));
      });
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (![200, 202, 409, 429].includes(res.statusCode) || !['idle', 'running', 'finished', 'failed', 'unavailable'].includes(result.state)) {
            resolve({ state: 'unavailable', reason: '本机检查代理返回异常' }); return;
          }
          const checks = Array.isArray(result.checks) ? result.checks.slice(0, 20)
            .filter(item => item && typeof item.name === 'string' && typeof item.detail === 'string'
              && ['ok', 'warning', 'finding', 'unavailable'].includes(item.state))
            .map(item => ({ name: item.name.slice(0, 60), state: item.state, detail: item.detail.slice(0, 180) })) : [];
          resolve({ state: result.state, checked_at: result.checked_at ?? null, reason: result.state === 'unavailable' ? '本机检查频率限制或代理异常' : undefined, checks });
        } catch {
          resolve({ state: 'unavailable', reason: '本机检查代理响应无效' });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ state: 'unavailable', reason: '本机检查代理未接入或超时' }));
    req.end();
  });
}

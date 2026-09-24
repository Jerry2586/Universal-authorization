import { writeFileSync, rmSync } from 'node:fs';
import { initialize } from './initialize.js';
import { supervise } from './supervisor.js';
import { checkHealth } from './health.js';

const statePath = '/tmp/appgog-processes.json';
const startupTimeoutMs = Number.parseInt(process.env.APPGOG_STARTUP_TIMEOUT_MS || '120000', 10);
if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 10000 || startupTimeoutMs > 600000) {
  throw new Error('APPGOG_STARTUP_TIMEOUT_MS 必须是 10000 到 600000 之间的整数');
}
rmSync(statePath, { force: true });
const { authUrl, buildUrl } = initialize();
// Never inherit administrator secrets into the worker, build proxy or Caddy environment.
const baseEnv = Object.fromEntries(['PATH', 'HOME', 'LANG', 'TZ', 'TMPDIR'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
async function waitHttp(url, stopped) {
  const deadline = Date.now() + startupTimeoutMs;
  let lastError;
  while (Date.now() < deadline && !stopped()) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      await response.arrayBuffer();
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`启动超时（${startupTimeoutMs}ms）：${url}${lastError?.message ? `；最后错误：${lastError.message}` : ''}`);
}
const app = supervise({ cwd: '/app', env: baseEnv, probe: () => checkHealth(), specs: [
  { name: 'license-center', command: process.execPath, args: ['apps/license-api/src/server.js'], env: { APPGOG_ENV_PATH: '/app/runtime/license/runtime.env' }, ready: stopped => waitHttp('http://127.0.0.1:8787/health', stopped) },
  { name: 'build-center', command: process.execPath, args: ['apps/build-center/src/server.js'], env: { APPGOG_ENV_PATH: '/app/runtime/build/runtime.env' }, ready: stopped => waitHttp('http://127.0.0.1:8788/health', stopped) },
  { name: 'build-worker', command: process.execPath, args: ['apps/build-worker/src/server.js'], env: { APPGOG_ENV_PATH: '/app/runtime/worker/runtime.env' } },
  { name: 'caddy', command: 'caddy', args: ['run', '--config', '/app/Caddyfile', '--adapter', 'caddyfile'], env: { AUTH_DOMAIN: new URL(authUrl).host, BUILD_DOMAIN: new URL(buildUrl).host, XDG_DATA_HOME: '/app/runtime/caddy-data', XDG_CONFIG_HOME: '/app/runtime/caddy-config' }, ready: stopped => waitHttp('http://127.0.0.1:8081/health', stopped) },
] });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.stop());
try {
  const children = await app.ready;
  writeFileSync(statePath, JSON.stringify({ ready: true, pids: children.map(child => child.pid) }), { mode: 0o600 });
  console.log('[appgog] 单容器全部进程就绪');
} catch (error) {
  console.error('[appgog] 启动失败：' + (error?.stack || error));
  app.stop(1);
}
process.exitCode = await app.done;
rmSync(statePath, { force: true });

import { writeFileSync, rmSync } from 'node:fs';
import { initialize } from './initialize.js';
import { supervise } from './supervisor.js';
import { checkHealth } from './health.js';

const statePath = '/tmp/appgog-processes.json';
rmSync(statePath, { force: true });
const { authUrl, buildUrl } = initialize();
// Never inherit administrator secrets into the worker, build proxy or Caddy environment.
const baseEnv = Object.fromEntries(['PATH', 'HOME', 'LANG', 'TZ', 'TMPDIR'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
async function waitHttp(url, stopped) {
  for (let attempt = 0; attempt < 60 && !stopped(); attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      await response.arrayBuffer();
      if (response.ok) return;
    } catch { /* A child is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('启动超时：' + url);
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
} catch { app.stop(1); }
process.exitCode = await app.done;
rmSync(statePath, { force: true });

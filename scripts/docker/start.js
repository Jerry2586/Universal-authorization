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
const { authUrl, buildUrl, deploymentRole, unpaired = false } = initialize();
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
const activeRoles = deploymentRole === 'all' ? ['license', 'build'] : [deploymentRole];
const cloudAgentSpecs = process.env.SECURITY_CLOUD_URL ? activeRoles.map(role => ({
  name: `security-agent-${role}`, command: process.execPath,
  args: ['scripts/security-agent.js', '--watch'],
  env: { SECURITY_CLOUD_URL: process.env.SECURITY_CLOUD_URL,
    SECURITY_CLOUD_CA: '/app/runtime/security/ca.crt',
    SECURITY_CLOUD_CLIENT_CERT: `/app/runtime/security/${role}.crt`,
    SECURITY_CLOUD_CLIENT_KEY: `/app/runtime/security/${role}.key`,
    SECURITY_CLOUD_TOKEN: process.env[`SECURITY_CLOUD_${role.toUpperCase()}_TOKEN`],
    SECURITY_SCAN_ROOT: '/app', SECURITY_REPORT_HOST: 'true',
    SECURITY_HOST_SCAN_SOCKET: '/app/runtime/host-security/scan.sock' },
})) : [];
const app = supervise({ cwd: '/app', env: baseEnv, probe: () => checkHealth(), specs: [
  ...(deploymentRole !== 'build' ? [{ name: 'license-center', command: process.execPath, args: ['apps/license-api/src/server.js'], env: { APPGOG_ENV_PATH: '/app/runtime/license/runtime.env' }, ready: stopped => waitHttp('http://127.0.0.1:8787/health', stopped) }] : []),
  ...(unpaired ? [{ name: 'build-standby', command: process.execPath, args: ['scripts/docker/unpaired.js'], env: {}, ready: stopped => waitHttp('http://127.0.0.1:8788/health', stopped) }] : []),
  ...(!unpaired && deploymentRole !== 'license' ? [{ name: 'build-center', command: process.execPath, args: ['apps/build-center/src/server.js'], env: { APPGOG_ENV_PATH: '/app/runtime/build/runtime.env' }, ready: stopped => waitHttp('http://127.0.0.1:8788/health', stopped) },
  { name: 'build-worker', command: process.execPath, args: ['apps/build-worker/src/server.js'], env: { APPGOG_ENV_PATH: '/app/runtime/worker/runtime.env' } }] : []),
  ...cloudAgentSpecs,
  { name: 'caddy', command: 'caddy', args: ['run', '--config', deploymentRole === 'all' ? '/app/Caddyfile' : `/app/Caddyfile.${deploymentRole}`, '--adapter', 'caddyfile'], env: { AUTH_DOMAIN: new URL(authUrl).host, BUILD_DOMAIN: new URL(buildUrl).host, XDG_DATA_HOME: '/app/runtime/caddy-data', XDG_CONFIG_HOME: '/app/runtime/caddy-config' }, ready: stopped => waitHttp('http://127.0.0.1:8081/health', stopped) },
] });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.stop());
try {
  const children = await app.ready;
  writeFileSync(statePath, JSON.stringify({ ready: true, pids: children.map(child => child.pid) }), { mode: 0o600 });
  console.log(`[appgog] ${deploymentRole} 容器进程就绪`);
} catch (error) {
  console.error('[appgog] 启动失败：' + (error?.stack || error));
  app.stop(1);
}
process.exitCode = await app.done;
rmSync(statePath, { force: true });

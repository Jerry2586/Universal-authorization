import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PACKAGE_VERSION } from '../../packages/core/src/version.js';

export const healthUrls = { license: 'http://127.0.0.1:8787/health', build: 'http://127.0.0.1:8788/health', caddy: 'http://127.0.0.1:8081/health' };
export function roleHealthUrls(role) {
  if (!['all', 'license', 'build'].includes(role)) throw new Error('无效部署角色');
  return [...(role === 'build' ? [] : [healthUrls.license]), ...(role === 'license' ? [] : [healthUrls.build]), healthUrls.caddy];
}
export async function checkHealth(statePath = '/tmp/appgog-processes.json') {
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const role = process.env.APPGOG_DEPLOYMENT_ROLE || 'all';
  const urls = roleHealthUrls(role);
  const processCount = (role === 'all' ? 4 : role === 'build' ? 3 : 2) + (process.env.SECURITY_CLOUD_URL ? role === 'all' ? 2 : 1 : 0);
  if (state.pids?.length !== processCount || !state.ready) throw new Error('部署进程尚未全部就绪');
  for (const pid of state.pids) {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('无效的进程状态');
    process.kill(pid, 0);
  }
  if (process.env.APPGOG_VERSION && process.env.APPGOG_VERSION !== PACKAGE_VERSION) throw new Error('容器环境与源码版本不一致');
  await Promise.all(urls.map(async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });

    if (!response.ok) throw new Error('服务健康检查失败：' + url);
    if (url !== healthUrls.caddy) {
      const health = await response.json();
      if (health.version !== PACKAGE_VERSION || (url === healthUrls.build && health.upstream_version !== PACKAGE_VERSION)) {
        throw new Error('服务运行版本不一致：' + url);
      }
    } else await response.arrayBuffer();
  }));
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try { await checkHealth(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

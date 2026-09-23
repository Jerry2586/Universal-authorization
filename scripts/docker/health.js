import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const healthUrls = ['http://127.0.0.1:8787/health', 'http://127.0.0.1:8788/health', 'http://127.0.0.1:8081/health'];
export async function checkHealth(statePath = '/tmp/appgog-processes.json') {
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  if (state.pids?.length !== 4 || !state.ready) throw new Error('四个进程尚未全部就绪');
  for (const pid of state.pids) {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('无效的进程状态');
    process.kill(pid, 0);
  }
  await Promise.all(healthUrls.map(async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    await response.arrayBuffer();
    if (!response.ok) throw new Error('服务健康检查失败：' + url);
  }));
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try { await checkHealth(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

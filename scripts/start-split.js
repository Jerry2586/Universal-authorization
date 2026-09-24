import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { loadConfig } from '../apps/license-api/src/config.js';
import { loadLocalEnvironment } from '../packages/core/src/environment.js';

// 本机开发用进程管理器；生产环境分别部署三个服务并使用各自的环境文件。
loadLocalEnvironment();
const internalToken = process.env.INTERNAL_SERVICE_TOKEN || (process.env.NODE_ENV === 'production' ? '' : randomBytes(48).toString('base64url'));
const config = loadConfig({ surface: 'license-center', embeddedWorker: false, internalServiceToken: internalToken });
const buildPort = Number.parseInt(process.env.BUILD_CENTER_PORT ?? '8788', 10);
if (!Number.isInteger(buildPort) || buildPort < 1 || buildPort > 65535) throw new Error('BUILD_CENTER_PORT 无效');
const internalUrl = `http://127.0.0.1:${config.port}`;
const children = [];
let stopping = false;
const safeProcessEnvironment = Object.fromEntries(
  ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'TZ']
    .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]),
);

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  for (const child of children) if (child.exitCode === null) child.kill();
}

function launch(name, file, env = {}, isolated = false) {
  const child = spawn(process.execPath, [file], {
    cwd: process.cwd(), stdio: 'inherit',
    env: {
      ...(isolated ? safeProcessEnvironment : process.env),
      ...(isolated ? { APPGOG_SKIP_DOTENV: 'true' } : {}),
      INTERNAL_LICENSE_URL: internalUrl, ...env,
    },
  });
  children.push(child);
  child.on('error', (error) => { console.error(`[${name}]`, error); stop(1); });
  child.on('exit', (code) => {
    if (!stopping) { console.error(`[${name}] 已退出 (${code ?? 'signal'})`); stop(1); }
  });
  return child;
}

async function ready(url) {
  for (let attempt = 0; attempt < 50 && !stopping; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* 服务还在启动 */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${url} 启动超时`);
}

process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

try {
  launch('license-center', 'apps/license-api/src/server.js', {
    APPGOG_SURFACE: 'license-center', EMBEDDED_WORKER: 'false', INTERNAL_SERVICE_TOKEN: internalToken,
  });
  await ready(`${internalUrl}/health`);
  launch('build-center', 'apps/build-center/src/server.js', {
    NODE_ENV: process.env.NODE_ENV ?? 'development', BUILD_CENTER_PORT: String(buildPort), INTERNAL_SERVICE_TOKEN: internalToken,
  }, true);
  await ready(`http://127.0.0.1:${buildPort}/health`);
  launch('build-worker', 'apps/build-worker/src/server.js', {
    NODE_ENV: process.env.NODE_ENV ?? 'development', WORKER_TOKEN: config.workerToken,
    PUBLIC_BASE_URL: config.publicBaseUrl, ARTIFACT_ROOT: config.artifactRoot,
    WORKER_ID: process.env.WORKER_ID ?? `worker-${process.pid}`,
  }, true);
  console.log(`授权中心: ${internalUrl}/admin | 客户打包中心: http://127.0.0.1:${buildPort}/build`);
} catch (error) {
  console.error(error);
  stop(1);
}

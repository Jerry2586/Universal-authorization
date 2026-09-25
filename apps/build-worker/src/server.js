import { resolve } from 'node:path';
import { LocalArtifactStore } from '../../../packages/adapters/src/local-artifact-store.js';
import { HardenedThemeBuildEngine } from './engine.js';
import { loadLocalEnvironment } from '../../../packages/core/src/environment.js';

export async function runWorkerOnce({
  baseUrl, token, workerId, artifactStore, publicKey, publicKeys = null, publicBaseUrl, remoteTransfer = false, requestTimeoutMs = 30_000, transferTimeoutMs = 300_000, fetchImpl = fetch,
}) {
  let stage = '领取构建任务';
  async function networkOperation(operation) {
    try {
      return await operation();
    } catch (cause) {
      const allowed = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET']);
      const reason = cause?.name === 'TimeoutError' || cause?.name === 'AbortError'
        ? 'TIMEOUT' : allowed.has(cause?.cause?.code) ? cause.cause.code : 'NETWORK_ERROR';
      const error = new Error(stage + '失败：' + reason + '；请检查 Worker 到授权中心的连接');
      error.code = 'WORKER_' + reason;
      throw error;
    }
  }
  async function request(path, options, timeoutMs) {
    return networkOperation(() => fetchImpl(new URL(path, baseUrl), { ...options, signal: AbortSignal.timeout(timeoutMs) }));
  }
  async function post(path, body) {
    const response = await request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, requestTimeoutMs);
    const value = await networkOperation(() => response.json());
    if (!response.ok) throw new Error(value.error?.message ?? `Worker API ${response.status}`);
    return value;
  }
  async function binary(path, { method = 'GET', body } = {}) {
    const response = await request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/zip' } : {}) },
      ...(body ? { body } : {}),
    }, transferTimeoutMs);
    if (!response.ok) {
      let message = `Worker transfer API ${response.status}`;
      try { message = (await response.json()).error?.message ?? message; } catch { /* Binary error body. */ }
      throw new Error(message);
    }
    return networkOperation(async () => method === 'GET' ? Buffer.from(await response.arrayBuffer()) : response.json());
  }
  const { task } = await post('/api/v1/worker/jobs/lease', { worker_id: workerId });
  if (!task) return false;
  const { job, source, build } = task;
  try {
    stage = '回报构建进度';
    await post(`/api/v1/worker/jobs/${job.id}/progress`, { worker_id: workerId, progress: 18, message: '正在检查官方主题 ZIP' });
    stage = '下载主题源码';
    const sourceBuffer = remoteTransfer
      ? await binary(`/api/v1/worker/jobs/${job.id}/source?worker_id=${encodeURIComponent(workerId)}`)
      : null;
    const canonicalBaseUrl = build.licenseServer ?? publicBaseUrl;
    const resolvedKeys = publicKeys ?? { activation: publicKey, package: publicKey, notification: publicKey };
    const engine = new HardenedThemeBuildEngine({
      artifactStore,
      publicKey: resolvedKeys.activation,
      activationPublicKey: resolvedKeys.activation,
      packagePublicKey: resolvedKeys.package,
      notificationPublicKey: resolvedKeys.notification,
      publicBaseUrl: canonicalBaseUrl,
    });
    stage = '保护并打包主题';
    const output = await engine.build({
      sourceRef: source.source_ref, sourceBuffer,
      product: build.product,
      version: build.version,
      buildId: build.buildId,
      packageId: build.packageId,
      packageSecret: build.packageSecret,
      packageManifestToken: build.packageManifestToken,
      watermark: build.watermark,
      domain: build.domain,
    });
    stage = '回报构建进度';
    await post(`/api/v1/worker/jobs/${job.id}/progress`, { worker_id: workerId, progress: 82, message: '正在写入客户专属成品' });
    let artifactRef;
    let artifactSha256 = output.sha256;
    if (remoteTransfer) {
      stage = '上传构建成品';
      const uploaded = await binary(`/api/v1/worker/jobs/${job.id}/artifact?worker_id=${encodeURIComponent(workerId)}`, { method: 'PUT', body: output.buffer });
      artifactRef = uploaded.artifact_ref;
      artifactSha256 = uploaded.artifact_sha256;
    } else {
      artifactRef = `builds/${job.id}/APPGOG-${build.version}-${build.buildId}.zip`;
      artifactStore.put(artifactRef, output.buffer);
    }
    stage = '确认构建完成';
    await post(`/api/v1/worker/jobs/${job.id}/complete`, {
      worker_id: workerId,
      build_id: build.buildId,
      artifact_ref: artifactRef,
      artifact_sha256: artifactSha256,
      install_key: build.installKey,
      package_proof: build.packageSecret,
    });
    return true;
  } catch (error) {
    try {
      await post(`/api/v1/worker/jobs/${job.id}/fail`, {
        worker_id: workerId,
        code: error.code ?? 'WORKER_BUILD_FAILED',
        message: String(error.message ?? '构建失败').slice(0, 300),
      });
    } catch (reportError) {
      console.error('[worker] failed to report failure:', reportError.code ?? 'WORKER_REPORT_FAILED');
    }
    throw error;
  }
}

export function resolveWorkerToken(env = process.env) {
  // Compose supplies an empty string for optional, unset node credentials.
  const token = env.WORKER_NODE_TOKEN || env.WORKER_TOKEN;
  if (!token || token.length < 32 || env.NODE_ENV === 'production' && /^(replace-with|development-)/.test(token)) {
    throw new Error('Worker 节点凭证无效');
  }
  return token;
}
export async function startWorker() {
  loadLocalEnvironment();
  const baseUrl = new URL(process.env.INTERNAL_LICENSE_URL ?? 'http://127.0.0.1:8787');
  if (!['http:', 'https:'].includes(baseUrl.protocol)) throw new Error('INTERNAL_LICENSE_URL 协议无效');
  const token = resolveWorkerToken();
  const workerId = process.env.WORKER_ID ?? `worker-${process.pid}`;

  const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? 'http://127.0.0.1:8787';
  if (process.env.NODE_ENV === 'production' && new URL(publicBaseUrl).protocol !== 'https:') throw new Error('生产环境 PUBLIC_BASE_URL 必须使用 HTTPS');
  const keyResponse = await fetch(new URL('/api/v1/public-key', baseUrl), { signal: AbortSignal.timeout(30_000) });
  if (!keyResponse.ok) throw new Error('无法从授权中心读取公钥');
  const keyDocument = await keyResponse.json();
  const publicKey = keyDocument.public_key;
  const publicKeys = keyDocument.public_keys ?? { activation: publicKey, package: publicKey, notification: publicKey };
  const remoteTransfer = (process.env.WORKER_REMOTE_TRANSFER ?? (process.env.WORKER_NODE_TOKEN ? 'true' : 'false')).toLowerCase() === 'true';
  const artifactStore = new LocalArtifactStore(resolve(process.cwd(), process.env.ARTIFACT_ROOT ?? './var/artifacts'));
  let stopped = false;
  const stop = () => { stopped = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  console.log(`APPGOG Worker ${workerId} started`);
  while (!stopped) {
    try {
      await runWorkerOnce({ baseUrl, token, workerId, artifactStore, publicKey, publicKeys, publicBaseUrl, remoteTransfer });
    } catch (error) { console.error('[worker]', error); }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.dirname, 'server.js')) {
  startWorker().catch((error) => { console.error(error); process.exitCode = 1; });
}

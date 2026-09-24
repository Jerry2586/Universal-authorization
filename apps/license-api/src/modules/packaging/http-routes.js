import { invariant } from '../../../../../packages/core/src/errors.js';

export async function handlePackagingHttp({
  method, url, request, response, service, portal, config, readJson, readBuffer,
  respondJson, requireToken, workerIdentity, zipHeaders, rateLimit,
}) {
  if (method === 'POST' && url.pathname === '/api/v1/builds/authorize') {
    rateLimit('build-authorize', 30, 15 * 60 * 1000);
    const body = await readJson(request);
    const result = service.authorizeBuild({ licenseKey: body.license_key, version: body.version, domain: body.domain });
    respondJson(response, 201, {
      build_ticket: result.buildTicket, ticket_id: result.ticketId,
      expires_at: result.expiresAt, product: result.product,
    });
    return true;
  }

  if (method === 'POST' && url.pathname === '/api/v1/worker/builds/claim') {
    requireToken(request, config.workerToken, '构建 Worker');
    const body = await readJson(request);
    const result = service.claimBuild({
      buildTicket: body.build_ticket, artifactSha256: body.artifact_sha256,
      installKeyTtlSeconds: body.install_key_ttl_seconds,
    });
    respondJson(response, 201, {
      build_id: result.buildId, product: result.product, version: result.version,
      domain: result.domain, package_id: result.packageId,
      package_secret: result.packageSecret, install_key: result.installKey,
    });
    return true;
  }

  if (method === 'POST' && url.pathname === '/api/v1/worker/jobs/lease') {
    invariant(portal.serviceEnabled('worker_enabled'), 'WORKER_DISABLED', '构建 Worker 服务已暂停', 503);
    const body = await readJson(request);
    const workerId = workerIdentity(request, body.worker_id);
    respondJson(response, 200, { task: portal.leaseBuild(workerId) });
    return true;
  }

  const progressMatch = url.pathname.match(/^\/api\/v1\/worker\/jobs\/([^/]+)\/progress$/);
  if (method === 'POST' && progressMatch) {
    const body = await readJson(request);
    const workerId = workerIdentity(request, body.worker_id);
    respondJson(response, 200, portal.updateBuildProgress(workerId, progressMatch[1], body));
    return true;
  }

  const sourceMatch = url.pathname.match(/^\/api\/v1\/worker\/jobs\/([^/]+)\/source$/);
  if (method === 'GET' && sourceMatch) {
    const workerId = workerIdentity(request, url.searchParams.get('worker_id'));
    const buffer = portal.sourceForWorker(workerId, sourceMatch[1]);
    response.writeHead(200, { ...zipHeaders(), 'content-length': buffer.length });
    response.end(buffer);
    return true;
  }

  const artifactMatch = url.pathname.match(/^\/api\/v1\/worker\/jobs\/([^/]+)\/artifact$/);
  if (method === 'PUT' && artifactMatch) {
    const workerId = workerIdentity(request, url.searchParams.get('worker_id'));
    invariant(request.headers['content-type'] === 'application/zip', 'ARTIFACT_CONTENT_TYPE_INVALID', '构建成品必须为 ZIP', 415);
    const buffer = await readBuffer(request, config.maxSourceUploadBytes);
    respondJson(response, 201, portal.saveWorkerArtifact(workerId, artifactMatch[1], buffer));
    return true;
  }

  const completeMatch = url.pathname.match(/^\/api\/v1\/worker\/jobs\/([^/]+)\/complete$/);
  if (method === 'POST' && completeMatch) {
    const body = await readJson(request);
    const workerId = workerIdentity(request, body.worker_id);
    respondJson(response, 200, portal.completeBuild(workerId, completeMatch[1], body));
    return true;
  }

  const failMatch = url.pathname.match(/^\/api\/v1\/worker\/jobs\/([^/]+)\/fail$/);
  if (method === 'POST' && failMatch) {
    const body = await readJson(request);
    const workerId = workerIdentity(request, body.worker_id);
    respondJson(response, 200, portal.failBuild(workerId, failMatch[1], body));
    return true;
  }

  return false;
}

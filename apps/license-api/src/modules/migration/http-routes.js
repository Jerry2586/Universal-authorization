export async function handleControlMigrationHttp({
  method, url, request, response, migrations, rateLimit,
  readJson, bearer, respondJson, requireOwnerSession,
}) {
  if (method === 'POST' && url.pathname === '/api/v1/control-migrations/handshake') {
    rateLimit('migration-pair', 8, 15 * 60 * 1000);
    const body = await readJson(request);
    respondJson(response, 200, migrations.handshake({
      pairingCode: body.pairing_code,
      migrationId: body.migration_id,
      sourceDeploymentId: body.source_deployment_id,
      sourceVersion: body.source_version,
      ownershipGeneration: body.ownership_generation,
    }));
    return true;
  }

  const chunkMatch = url.pathname.match(/^\/api\/v1\/control-migrations\/([^/]+)\/bundle\/chunks\/(\d+)$/);
  if (method === 'PUT' && chunkMatch) {
    const result = await migrations.receiveChunk({
      request,
      id: chunkMatch[1],
      token: bearer(request),
      index: Number(chunkMatch[2]),
      totalChunks: Number(request.headers['x-appgog-total-chunks']),
      expectedSha256: request.headers['x-appgog-chunk-sha256'],
    });
    respondJson(response, 202, result);
    return true;
  }

  const completeMatch = url.pathname.match(/^\/api\/v1\/control-migrations\/([^/]+)\/bundle\/complete$/);
  if (method === 'POST' && completeMatch) {
    const body = await readJson(request);
    const result = migrations.completeChunks({
      id: completeMatch[1],
      token: bearer(request),
      totalChunks: Number(body.total_chunks),
      totalSha256: body.total_sha256,
      backupKey: body.backup_key,
    });
    respondJson(response, 202, result);
    return true;
  }

  const uploadMatch = url.pathname.match(/^\/api\/v1\/control-migrations\/([^/]+)\/bundle$/);
  if (method === 'PUT' && uploadMatch) {
    const result = await migrations.receiveBundle({
      request, id: uploadMatch[1], token: bearer(request), backupKey: request.headers['x-appgog-backup-key'],
    });
    respondJson(response, 202, result);
    return true;
  }

  const statusMatch = url.pathname.match(/^\/api\/v1\/control-migrations\/([^/]+)\/status$/);
  if (method === 'GET' && statusMatch) {
    respondJson(response, 200, migrations.publicStatus(statusMatch[1], bearer(request)));
    return true;
  }

  if (method === 'GET' && url.pathname === '/web/admin/system/migrations') {
    requireOwnerSession(request, false);
    respondJson(response, 200, migrations.status());
    return true;
  }

  if (method === 'POST' && url.pathname === '/web/admin/system/migrations/receiver') {
    const session = requireOwnerSession(request, true);
    const opened = migrations.openReceiver(session.actor_id);
    respondJson(response, 201, opened);
    return true;
  }

  if (method === 'POST' && url.pathname === '/web/admin/system/migrations/receiver/close') {
    const session = requireOwnerSession(request, true);
    respondJson(response, 200, migrations.closeReceiver(session.actor_id));
    return true;
  }

  if (method === 'POST' && url.pathname === '/web/admin/system/migrations/source') {
    const session = requireOwnerSession(request, true);
    const body = await readJson(request);
    const started = migrations.beginSource({ targetUrl: body.target_url, pairingCode: body.pairing_code, actorId: session.actor_id });
    respondJson(response, 202, started);
    return true;
  }

  return false;
}

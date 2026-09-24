export async function handleOperationsHttp({
  method, url, request, response, portal, updates, readJson, respondJson, requireSession,
}) {
  if (method === 'POST' && url.pathname === '/web/admin/cms/settings') {
    const session = requireSession(true, 'system.manage');
    const body = await readJson(request);
    respondJson(response, 200, portal.updateCmsSettings(body, session.actor_id));
    return true;
  }

  if (method === 'POST' && url.pathname === '/web/admin/announcement') {
    const session = requireSession(true, 'system.manage');
    const body = await readJson(request);
    respondJson(response, 200, portal.updateAnnouncement(body, session.actor_id));
    return true;
  }

  if (method === 'GET' && url.pathname === '/web/admin/system/update') {
    requireSession(false, 'system.manage');
    respondJson(response, 200, updates.status());
    return true;
  }

  if (method === 'POST' && url.pathname === '/web/admin/system/update') {
    const session = requireSession(true, 'system.manage');
    const body = await readJson(request);
    const queued = updates.enqueue(body.action, body.version);
    respondJson(response, 202, portal.recordSystemUpdate(queued, session.actor_id));
    return true;
  }

  if (method === 'POST' && url.pathname === '/web/admin/cms/nodes') {
    const session = requireSession(true, 'system.manage');
    const body = await readJson(request);
    const result = portal.createServiceNode(body, session.actor_id);
    respondJson(response, 201, { ...result.node, node_credential: result.credential });
    return true;
  }

  const statusMatch = url.pathname.match(/^\/web\/admin\/cms\/nodes\/([^/]+)\/status$/);
  if (method === 'POST' && statusMatch) {
    const session = requireSession(true, 'system.manage');
    const body = await readJson(request);
    respondJson(response, 200, portal.changeServiceNodeStatus(statusMatch[1], body.status, session.actor_id));
    return true;
  }

  const rotateMatch = url.pathname.match(/^\/web\/admin\/cms\/nodes\/([^/]+)\/rotate$/);
  if (method === 'POST' && rotateMatch) {
    const session = requireSession(true, 'system.manage');
    const result = portal.rotateServiceNodeCredential(rotateMatch[1], session.actor_id);
    respondJson(response, 200, { ...result.node, node_credential: result.credential });
    return true;
  }

  return false;
}

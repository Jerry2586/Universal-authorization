export async function handleAdminAccountHttp({
  method, url, request, response, portal, readJson, respondJson, requireSession, clearAdminCookie,
}) {
  if (method === 'POST' && url.pathname === '/web/admin/admins') {
    const session = requireSession(true, 'admin.manage');
    const body = await readJson(request);
    respondJson(response, 201, portal.createAdminAccount(body, session.actor_id));
    return true;
  }

  const statusMatch = url.pathname.match(/^\/web\/admin\/admins\/([^/]+)\/status$/);
  if (method === 'POST' && statusMatch) {
    const session = requireSession(true, 'admin.manage');
    const body = await readJson(request);
    respondJson(response, 200, portal.changeAdminAccountStatus({ id: statusMatch[1], status: body.status, actorId: session.actor_id }));
    return true;
  }

  if (method === 'POST' && url.pathname === '/web/admin/account/password') {
    const session = requireSession(true);
    const body = await readJson(request);
    const result = portal.changeAdminPassword({
      id: session.actor_id, currentPassword: body.current_password,
      newPassword: body.new_password, confirmPassword: body.confirm_password,
    });
    respondJson(response, 200, result, { 'set-cookie': clearAdminCookie() });
    return true;
  }

  const deleteMatch = url.pathname.match(/^\/web\/admin\/admins\/([^/]+)$/);
  if (method === 'DELETE' && deleteMatch) {
    const session = requireSession(true, 'admin.manage');
    respondJson(response, 200, portal.deleteAdminAccount({ id: deleteMatch[1], actorId: session.actor_id }));
    return true;
  }

  return false;
}

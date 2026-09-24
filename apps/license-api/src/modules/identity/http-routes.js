import { invariant } from '../../../../../packages/core/src/errors.js';

export async function handleIdentityHttp({
  method, url, request, response, portal, sessions, auth, readJson, respondJson, rateLimit, clientAddress,
}) {
  if (method === 'POST' && url.pathname === '/web/customer/login') {
    invariant(portal.serviceEnabled('build_center_enabled') && portal.serviceEnabled('customer_login_enabled'),
      'BUILD_CENTER_MAINTENANCE', '客户打包中心正在维护', 503);
    rateLimit(`customer-login:${clientAddress}`, 12, 15 * 60 * 1000);
    const body = await readJson(request);
    const result = sessions.loginCustomer(body.license_key);
    respondJson(response, 200, {
      actor: 'customer', csrf_token: result.csrfToken,
      license: { product: result.license.product_code, key_prefix: result.license.key_prefix },
    }, { 'set-cookie': auth.cookieHeader('customer', result.token) });
    return true;
  }

  if (method === 'POST' && url.pathname === '/web/admin/login') {
    rateLimit(`admin-login:${clientAddress}`, 8, 15 * 60 * 1000);
    const body = await readJson(request);
    const result = sessions.loginAdmin(body.username, body.password, clientAddress);
    respondJson(response, 200, {
      actor: 'admin', id: result.admin.id, username: result.admin.username,
      display_name: result.admin.display_name, role: result.admin.role,
      permissions: result.admin.permissions, is_owner: Boolean(result.admin.is_owner), csrf_token: result.csrfToken,
    }, { 'set-cookie': auth.cookieHeader('admin', result.token) });
    return true;
  }

  if (method === 'GET' && url.pathname === '/web/session') {
    const actor = url.searchParams.get('actor');
    invariant(actor === 'admin' || actor === 'customer', 'ACTOR_INVALID', '会话身份无效', 400);
    const token = auth.sessionToken(actor);
    const session = sessions.requireActor(token, actor);
    if (actor === 'admin') {
      const { admin, permissions } = sessions.requireAdmin(token);
      respondJson(response, 200, {
        actor, id: admin.id, username: admin.username, display_name: admin.display_name,
        role: admin.role, is_owner: Boolean(admin.is_owner), permissions, csrf_token: session.csrf_token,
      });
      return true;
    }
    respondJson(response, 200, { actor, csrf_token: session.csrf_token });
    return true;
  }

  if (method === 'POST' && url.pathname === '/web/logout') {
    const actor = url.searchParams.get('actor');
    invariant(actor === 'admin' || actor === 'customer', 'ACTOR_INVALID', '会话身份无效', 400);
    const token = auth.sessionToken(actor);
    const session = sessions.requireActor(token, actor);
    sessions.verifyCsrf(session, request.headers['x-csrf-token']);
    sessions.logout(token);
    respondJson(response, 200, { ok: true }, { 'set-cookie': auth.clearCookieHeader(actor) });
    return true;
  }

  return false;
}

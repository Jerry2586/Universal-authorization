export async function handleEntitlementHttp({ method, url, request, response, service, auth, readJson, respondJson }) {
  const root = '/web/admin/plans';
  if (method === 'GET' && url.pathname === root) {
    auth.requireSession('admin', false, 'license.view');
    respondJson(response, 200, { plans: service.listLicensePlans() });
    return true;
  }
  const edit = url.pathname.match(/^\/web\/admin\/plans\/([a-z][a-z0-9_-]{1,39})$/);
  if (method !== 'POST' || (url.pathname !== root && !edit)) return false;
  const admin = auth.requireSession('admin', true, 'license.manage');
  const body = await readJson(request);
  const input = { code: edit ? edit[1] : body.code, name: body.name, accessTier: body.access_tier,
    status: body.status, capabilities: body.capabilities, limits: body.limits, actorId: admin.actor_id };
  const result = edit ? service.updateLicensePlan(input) : service.createLicensePlan(input);
  respondJson(response, edit ? 200 : 201, { plan: result });
  return true;
}

import { invariant } from '../../../../../packages/core/src/errors.js';
import { verifyPassword } from '../../../../../packages/core/src/password.js';

function licenseResult(result) {
  return {
    license_id: result.license.id,
    license_key: result.licenseKey,
    bound_domain: result.license.bound_domain,
    generation: result.license.generation,
  };
}

export async function handleLicensingHttp({
  method, url, request, response, service, portal, auth, config, readJson, respondJson, rateLimit, clientAddress,
}) {
  if (method === 'POST' && url.pathname === '/web/admin/licenses') {
    const admin = auth.requireSession('admin', true, 'license.issue');
    const body = await readJson(request);
    const result = service.issueLicense({
      productCode: body.product_code, customerRef: body.customer_ref, domain: body.domain,
      updateUntil: body.update_until, planCode: body.plan_code,
      maxBuildsPerDay: body.max_builds_per_day, maxActivations: body.max_activations,
      actorId: admin.actor_id,
    });
    respondJson(response, 201, licenseResult(result));
    return true;
  }

  const rotateMatch = url.pathname.match(/^\/web\/admin\/licenses\/([^/]+)\/rotate-key$/);
  if (method === 'POST' && rotateMatch) {
    const admin = auth.requireSession('admin', true, 'license.manage');
    respondJson(response, 200, licenseResult(service.rotateLicenseKey({ licenseId: rotateMatch[1], actorId: admin.actor_id })));
    return true;
  }

  const revealMatch = url.pathname.match(/^\/web\/admin\/licenses\/([^/]+)\/key$/);
  if (method === 'POST' && revealMatch) {
    rateLimit(`license-key-reveal:${clientAddress}`, 8, 15 * 60 * 1000);
    const authResult = auth.requireAdmin(true, 'license.manage');
    requireOwner(authResult.admin, 'LICENSE_KEY_REVEAL_FORBIDDEN', '只有平台所有者可以查看完整 Key');
    const body = await readJson(request);
    invariant(verifyPassword(String(body.password ?? ''), authResult.admin.password_hash),
      'ADMIN_PASSWORD_CURRENT_INVALID', '当前管理员密码不正确', 403);
    const result = service.revealLicenseKey({ licenseId: revealMatch[1], actorId: authResult.admin.id });
    respondJson(response, 200, { license_id: result.license.id, license_key: result.licenseKey });
    return true;
  }

  const domainMatch = url.pathname.match(/^\/web\/admin\/licenses\/([^/]+)\/domain$/);
  if (method === 'POST' && domainMatch) {
    const admin = auth.requireSession('admin', true, 'license.manage');
    const license = service.changeLicenseDomain({
      licenseId: domainMatch[1], domain: (await readJson(request)).domain, actorId: admin.actor_id,
    });
    respondJson(response, 200, { license_id: license.id, bound_domain: license.bound_domain, generation: license.generation });
    return true;
  }

  return handleLicensingMutations({
    method, url, request, response, service, portal, auth, config, readJson,
    respondJson, rateLimit, clientAddress,
  });
}

async function handleLicensingMutations({
  method, url, request, response, service, portal, auth, config, readJson, respondJson, rateLimit, clientAddress,
}) {
  const planMatch = url.pathname.match(/^\/web\/admin\/licenses\/([^/]+)\/plan$/);
  if (method === 'POST' && planMatch) {
    const admin = auth.requireSession('admin', true, 'license.manage');
    const license = service.changeLicensePlan({
      licenseId: planMatch[1], planCode: (await readJson(request)).plan_code, actorId: admin.actor_id,
    });
    respondJson(response, 200, { license_id: license.id, plan_code: license.plan_code, generation: license.generation });
    return true;
  }

  const deleteMatch = url.pathname.match(/^\/web\/admin\/licenses\/([^/]+)$/);
  if (method === 'DELETE' && deleteMatch) {
    rateLimit(`license-delete:${clientAddress}`, 5, 15 * 60 * 1000);
    const authResult = auth.requireAdmin(true, 'license.manage');
    requireOwner(authResult.admin, 'LICENSE_DELETE_FORBIDDEN', '只有平台所有者可以永久删除授权');
    const body = await readJson(request);
    invariant(verifyPassword(String(body.password ?? ''), authResult.admin.password_hash),
      'ADMIN_PASSWORD_CURRENT_INVALID', '当前管理员密码不正确', 403);
    invariant(String(body.confirmation ?? '') === `DELETE ${deleteMatch[1]}`,
      'LICENSE_DELETE_CONFIRMATION_INVALID', '永久删除确认文本不正确', 400);
    respondJson(response, 200, portal.deleteLicensePermanently({ licenseId: deleteMatch[1], actorId: authResult.admin.id }));
    return true;
  }

  const reviewMatch = url.pathname.match(/^\/web\/admin\/domain-migrations\/([^/]+)\/review$/);
  if (method === 'POST' && reviewMatch) {
    const admin = auth.requireSession('admin', true, 'license.manage');
    const body = await readJson(request);
    respondJson(response, 200, portal.reviewDomainMigration({
      requestId: reviewMatch[1], decision: body.decision, reviewNote: body.review_note, actorId: admin.actor_id,
    }));
    return true;
  }

  const statusMatch = url.pathname.match(/^\/web\/admin\/licenses\/([^/]+)\/status$/);
  if (method === 'POST' && statusMatch) {
    const admin = auth.requireSession('admin', true, 'license.manage');
    const license = service.changeLicenseStatus({
      licenseId: statusMatch[1], status: (await readJson(request)).status, actorId: admin.actor_id,
    });
    respondJson(response, 200, { license_id: license.id, status: license.status });
    return true;
  }

  if (method === 'POST' && url.pathname === '/api/v1/admin/licenses') {
    auth.requireToken(config.adminToken, '管理员');
    const body = await readJson(request);
    const result = service.issueLicense({
      productCode: body.product_code, customerRef: body.customer_ref, domain: body.domain,
      updateUntil: body.update_until, planCode: body.plan_code,
      maxBuildsPerDay: body.max_builds_per_day, maxActivations: body.max_activations,
    });
    respondJson(response, 201, {
      ...licenseResult(result), product: result.license.product_code,
    });
    return true;
  }

  const apiRotateMatch = url.pathname.match(/^\/api\/v1\/admin\/licenses\/([^/]+)\/rotate-key$/);
  if (method === 'POST' && apiRotateMatch) {
    auth.requireToken(config.adminToken, '管理员');
    respondJson(response, 200, licenseResult(service.rotateLicenseKey({ licenseId: apiRotateMatch[1] })));
    return true;
  }
  return false;
}

function requireOwner(admin, code, message) {
  invariant(admin.is_owner || admin.role === 'owner' || admin.role === 'super_admin', code, message, 403);
}

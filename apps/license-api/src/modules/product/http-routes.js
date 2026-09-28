import { invariant } from '../../../../../packages/core/src/errors.js';

export async function handleProductHttp({
  method, url, request, response, portal, auth, config, readJson, readBuffer, respondJson,
}) {
  if (url.pathname === '/web/admin/products' && method === 'GET') {
    auth.requireSession('admin', false, 'product.view');
    respondJson(response, 200, { products: portal.listProducts() });
    return true;
  }
  if (url.pathname === '/web/admin/products' && method === 'POST') {
    const admin = auth.requireSession('admin', true, 'product.manage');
    const body = await readJson(request);
    respondJson(response, 201, portal.createManagedProduct({ code: body.code, name: body.name, actorId: admin.actor_id }));
    return true;
  }
  const productMatch = url.pathname.match(/^\/web\/admin\/products\/([^/]+)$/);
  if (productMatch && method === 'PATCH') {
    const admin = auth.requireSession('admin', true, 'product.manage');
    const body = await readJson(request);
    invariant(body.code === undefined || body.code === productMatch[1], 'PRODUCT_CODE_IMMUTABLE', '产品标识创建后不能修改');
    respondJson(response, 200, portal.updateManagedProduct({ code: productMatch[1], name: body.name, status: body.status, actorId: admin.actor_id }));
    return true;
  }
  if (method === 'POST' && url.pathname === '/web/admin/versions') {
    auth.requireSession('admin', true, 'version.publish');
    const body = await readJson(request);
    const version = portal.registerSourceVersion({
      allowProductCreation: false, productCode: body.product_code, version: body.version, displayName: body.display_name,
      releaseNotes: body.release_notes, channel: body.channel, releaseKind: body.release_kind,
      accessTier: body.access_tier, planCodes: body.plan_codes ?? [],
    });
    respondJson(response, 201, versionResult(version));
    return true;
  }

  if (method === 'POST' && url.pathname === '/web/admin/versions/upload') {
    const admin = auth.requireSession('admin', true, 'version.publish');
    invariant(request.headers['content-type'] === 'application/zip', 'SOURCE_CONTENT_TYPE_INVALID', '请上传 ZIP 文件', 415);
    const version = portal.publishSourceVersion({
      allowProductCreation: false, productCode: url.searchParams.get('product_code') || 'appgog',
      version: url.searchParams.get('version'), displayName: url.searchParams.get('display_name'),
      sourceFilename: url.searchParams.get('source_filename'), releaseNotes: url.searchParams.get('release_notes'),
      channel: url.searchParams.get('channel'), releaseKind: url.searchParams.get('release_kind'),
      accessTier: url.searchParams.get('access_tier'), planCodes: url.searchParams.getAll('plan_code'),
      actorId: admin.actor_id, zipBuffer: await readBuffer(request, config.maxSourceUploadBytes),
    });
    respondJson(response, 201, versionResult(version));
    return true;
  }

  const plansMatch = url.pathname.match(/^\/web\/admin\/versions\/([^/]+)\/plans$/);
  if (method === 'POST' && plansMatch) {
    const admin = auth.requireSession('admin', true, 'version.manage');
    const body = await readJson(request);
    respondJson(response, 200, versionResult(portal.changeVersionPlans({ id:plansMatch[1], planCodes:body.plan_codes, actorId:admin.actor_id })));
    return true;
  }
  const withdrawMatch = url.pathname.match(/^\/web\/admin\/versions\/([^/]+)\/withdraw$/);
  if (method === 'POST' && withdrawMatch) {
    const admin = auth.requireSession('admin', true, 'version.manage');
    const version = portal.withdrawSourceVersion({
      id: withdrawMatch[1], reason: (await readJson(request)).reason, actorId: admin.actor_id,
    });
    respondJson(response, 200, {
      id: version.id, version: version.version, status: version.status, withdrawn_reason: version.withdrawn_reason,
    });
    return true;
  }
  return false;
}

function versionResult(version) {
  return {
    id: version.id, version: version.version, display_name: version.display_name,
    plan_codes: version.plan_codes_json == null ? null : JSON.parse(version.plan_codes_json),
    source_kind: version.source_kind, status: version.status, access_tier: version.access_tier,
  };
}

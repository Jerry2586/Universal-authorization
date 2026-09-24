import { invariant } from '../../../../../packages/core/src/errors.js';

export async function handleProductHttp({
  method, url, request, response, portal, auth, config, readJson, readBuffer, respondJson,
}) {
  if (method === 'POST' && url.pathname === '/web/admin/versions') {
    auth.requireSession('admin', true, 'version.publish');
    const body = await readJson(request);
    const version = portal.registerSourceVersion({
      productCode: body.product_code, version: body.version, displayName: body.display_name,
      releaseNotes: body.release_notes, channel: body.channel, releaseKind: body.release_kind,
    });
    respondJson(response, 201, versionResult(version));
    return true;
  }

  if (method === 'POST' && url.pathname === '/web/admin/versions/upload') {
    const admin = auth.requireSession('admin', true, 'version.publish');
    invariant(request.headers['content-type'] === 'application/zip', 'SOURCE_CONTENT_TYPE_INVALID', '请上传 ZIP 文件', 415);
    const version = portal.publishSourceVersion({
      productCode: url.searchParams.get('product_code') || 'appgog',
      version: url.searchParams.get('version'), displayName: url.searchParams.get('display_name'),
      sourceFilename: url.searchParams.get('source_filename'), releaseNotes: url.searchParams.get('release_notes'),
      channel: url.searchParams.get('channel'), releaseKind: url.searchParams.get('release_kind'),
      actorId: admin.actor_id, zipBuffer: await readBuffer(request, config.maxSourceUploadBytes),
    });
    respondJson(response, 201, versionResult(version));
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
    source_kind: version.source_kind, status: version.status,
  };
}

import { createHmac, randomBytes } from 'node:crypto';
import { DomainError, invariant } from '../../../../../packages/core/src/errors.js';
import { safeEqual } from '../../http/middleware/auth.js';

function issueDownloadTicket(config, session, jobId) {
  const expiresAt = Date.now() + (config.downloadTicketTtlSeconds ?? 300) * 1000;
  const payload = Buffer.from(JSON.stringify({
    v: 1, j: jobId, s: session.id, e: Math.floor(expiresAt / 1000), n: randomBytes(12).toString('base64url'),
  }), 'utf8').toString('base64url');
  const signature = createHmac('sha256', config.sessionSecret)
    .update(`appgog-download:${payload}`, 'utf8').digest('base64url');
  return { token: `${payload}.${signature}`, expiresAt: new Date(expiresAt).toISOString() };
}

function verifyDownloadTicket(config, token, session, jobId) {
  const [payload, signature, extra] = String(token ?? '').split('.');
  invariant(payload && signature && !extra, 'DOWNLOAD_TICKET_REQUIRED', '下载地址无效或已过期，请重新领取', 403);
  const expected = createHmac('sha256', config.sessionSecret)
    .update(`appgog-download:${payload}`, 'utf8').digest('base64url');
  invariant(safeEqual(signature, expected), 'DOWNLOAD_TICKET_INVALID', '下载地址无效或已被篡改', 403);
  let claims;
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch { throw new DomainError('DOWNLOAD_TICKET_INVALID', '下载地址无效或已被篡改', 403); }
  invariant(claims.v === 1 && claims.j === jobId && claims.s === session.id,
    'DOWNLOAD_TICKET_INVALID', '下载地址不属于当前登录会话或构建任务', 403);
  invariant(Number.isSafeInteger(claims.e) && claims.e > Math.floor(Date.now() / 1000),
    'DOWNLOAD_TICKET_EXPIRED', '下载地址已过期，请重新领取', 403);
}

export async function handleCustomerHttp({
  method, url, request, response, portal, artifactStore, auth, config, readJson, respondJson, rateLimit, securityHeaders,
}) {
  if (method === 'GET' && url.pathname === '/web/customer/overview') {
    invariant(portal.serviceEnabled('build_center_enabled'), 'BUILD_CENTER_MAINTENANCE', '客户打包中心正在维护', 503);
    respondJson(response, 200, portal.customerOverview(auth.requireSession('customer')));
    return true;
  }

  if (method === 'POST' && url.pathname === '/web/customer/builds') {
    invariant(portal.serviceEnabled('build_center_enabled') && portal.serviceEnabled('new_builds_enabled'),
      'NEW_BUILDS_DISABLED', '当前暂停接收新构建', 503);
    const session = auth.requireSession('customer', true);
    respondJson(response, 201, portal.enqueueCustomerBuild(session, await readJson(request)));
    return true;
  }

  return handleCustomerDetails({
    method, url, response, portal, artifactStore, auth, config, readJson,
    respondJson, rateLimit, securityHeaders, request,
  });
}

async function handleCustomerDetails({
  method, url, request, response, portal, artifactStore, auth, config, readJson,
  respondJson, rateLimit, securityHeaders,
}) {
  if (method === 'POST' && url.pathname === '/web/customer/domain/bind') {
    const session = auth.requireSession('customer', true);
    respondJson(response, 200, portal.bindCustomerDomain(session, await readJson(request)));
    return true;
  }
  if (method === 'POST' && url.pathname === '/web/customer/domain-migrations') {
    const session = auth.requireSession('customer', true);
    respondJson(response, 201, portal.requestCustomerDomainMigration(session, await readJson(request)));
    return true;
  }

  const voidMatch = url.pathname.match(/^\/web\/customer\/builds\/([^/]+)\/void$/);
  if (method === 'POST' && voidMatch) {
    respondJson(response, 200, portal.voidCustomerBuild(auth.requireSession('customer', true), voidMatch[1]));
    return true;
  }

  const buildMatch = url.pathname.match(/^\/web\/customer\/builds\/([^/]+)$/);
  if (method === 'GET' && buildMatch) {
    respondJson(response, 200, portal.buildDetails(auth.requireSession('customer'), buildMatch[1]));
    return true;
  }

  const ticketMatch = url.pathname.match(/^\/web\/customer\/builds\/([^/]+)\/download-ticket$/);
  if (method === 'POST' && ticketMatch) {
    const session = auth.requireSession('customer', true);
    portal.artifactForDownload(session, ticketMatch[1]);
    rateLimit(`download-ticket:${session.id}`, 60, 15 * 60 * 1000);
    const ticket = issueDownloadTicket(config, session, ticketMatch[1]);
    respondJson(response, 201, {
      download_url: `/web/customer/builds/${encodeURIComponent(ticketMatch[1])}/download?ticket=${encodeURIComponent(ticket.token)}`,
      expires_at: ticket.expiresAt,
    });
    return true;
  }

  const downloadMatch = url.pathname.match(/^\/web\/customer\/builds\/([^/]+)\/download$/);
  if (method === 'GET' && downloadMatch) {
    const session = auth.requireSession('customer');
    verifyDownloadTicket(config, url.searchParams.get('ticket'), session, downloadMatch[1]);
    const artifact = portal.artifactForDownload(session, downloadMatch[1]);
    const size = artifactStore.size(artifact.key);
    response.writeHead(200, {
      ...securityHeaders('application/zip'), 'content-length': size,
      'content-disposition': `attachment; filename="${artifact.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
      'x-appgog-sha256': artifact.sha256,
    });
    artifactStore.open(artifact.key).pipe(response);
    return true;
  }
  return false;
}

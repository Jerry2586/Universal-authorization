import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { DomainError, invariant } from '../../../packages/core/src/errors.js';
import { verifyPassword } from '../../../packages/core/src/password.js';
import { handleActivationHttp } from './modules/activation/http-routes.js';
import { handleAdminAccountHttp } from './modules/admin/http-routes.js';
import { handleControlMigrationHttp } from './modules/migration/http-routes.js';
import { handleOperationsHttp } from './modules/operations/http-routes.js';
import { handlePackagingHttp } from './modules/packaging/http-routes.js';
import { handleSupportHttp } from './modules/support/http-routes.js';

const PUBLIC_ROOT = resolve(process.cwd(), 'apps/web/public');
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;
const SESSION_COOKIES = Object.freeze({ admin: 'appgog_admin_session', customer: 'appgog_customer_session' });

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
});

function securityHeaders(contentType = 'application/json; charset=utf-8') {
  return {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  };
}

function json(response, status, body, headers = {}) {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    ...securityHeaders(),
    'content-length': encoded.length,
    ...headers,
  });
  response.end(encoded);
}

async function readJson(request, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new DomainError('BODY_TOO_LARGE', '请求内容过大', 413);
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new DomainError('JSON_INVALID', '请求 JSON 格式无效', 400);
  }
}

async function readBuffer(request, limit) {
  const announced = Number(request.headers['content-length'] ?? 0);
  if (announced > limit) throw new DomainError('BODY_TOO_LARGE', '上传文件超出大小限制', 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new DomainError('BODY_TOO_LARGE', '上传文件超出大小限制', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function bearer(request) {
  const value = request.headers.authorization ?? '';
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

function safeEqual(left, right) {
  const a = Buffer.from(left ?? '');
  const b = Buffer.from(right ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}

function trustedProxyAddress(address) {
  const value = String(address ?? '').toLowerCase().replace(/^::ffff:/, '');
  if (value === '::1' || value === '127.0.0.1' || value.startsWith('10.') || value.startsWith('192.168.')) return true;
  const match = value.match(/^172\.(\d+)\./);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  return value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:');
}

function clientAddress(request) {
  const direct = String(request.socket.remoteAddress ?? 'unknown');
  if (!trustedProxyAddress(direct)) return direct;
  const forwarded = String(request.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return isIP(forwarded) ? forwarded : direct;
}

function issueDownloadTicket(config, session, jobId) {
  const expiresAt = Date.now() + (config.downloadTicketTtlSeconds ?? 300) * 1000;
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    j: jobId,
    s: session.id,
    e: Math.floor(expiresAt / 1000),
    n: randomBytes(12).toString('base64url'),
  }), 'utf8').toString('base64url');
  const signature = createHmac('sha256', config.sessionSecret)
    .update(`appgog-download:${payload}`, 'utf8')
    .digest('base64url');
  return { token: `${payload}.${signature}`, expiresAt: new Date(expiresAt).toISOString() };
}

function verifyDownloadTicket(config, token, session, jobId) {
  const [payload, signature, extra] = String(token ?? '').split('.');
  invariant(payload && signature && !extra, 'DOWNLOAD_TICKET_REQUIRED', '下载地址无效或已过期，请重新领取', 403);
  const expected = createHmac('sha256', config.sessionSecret)
    .update(`appgog-download:${payload}`, 'utf8')
    .digest('base64url');
  invariant(safeEqual(signature, expected), 'DOWNLOAD_TICKET_INVALID', '下载地址无效或已被篡改', 403);
  let claims;
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch { throw new DomainError('DOWNLOAD_TICKET_INVALID', '下载地址无效或已被篡改', 403); }
  invariant(claims.v === 1 && claims.j === jobId && claims.s === session.id,
    'DOWNLOAD_TICKET_INVALID', '下载地址不属于当前登录会话或构建任务', 403);
  invariant(Number.isSafeInteger(claims.e) && claims.e > Math.floor(Date.now() / 1000),
    'DOWNLOAD_TICKET_EXPIRED', '下载地址已过期，请重新领取', 403);
}

function requireToken(request, expected, role) {
  if (!safeEqual(bearer(request), expected)) {
    throw new DomainError('UNAUTHORIZED', `${role} 凭证无效`, 401);
  }
}

function cookies(request) {
  const output = {};
  for (const pair of String(request.headers.cookie ?? '').split(';')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    try {
      output[pair.slice(0, separator).trim()] = decodeURIComponent(pair.slice(separator + 1).trim());
    } catch {
      // Ignore malformed cookie input.
    }
  }
  return output;
}

function cookieHeader(token, config, actor) {
  const secure = new URL(config.publicBaseUrl).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIES[actor]}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${config.webSessionTtlSeconds}${secure}`;
}

function clearCookieHeader(config, actor) {
  const secure = new URL(config.publicBaseUrl).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIES[actor]}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`;
}

function sessionToken(request, actor) {
  return cookies(request)[SESSION_COOKIES[actor]] ?? '';
}

function requireWebSession(request, sessions, actorType, requireCsrf = false, permission = null) {
  const session = actorType === 'admin'
    ? sessions.requireAdmin(sessionToken(request, actorType), permission).session
    : sessions.requireActor(sessionToken(request, actorType), actorType);
  if (requireCsrf) sessions.verifyCsrf(session, request.headers['x-csrf-token']);
  return session;
}

function requireOwnerWebSession(request, sessions, requireCsrf = false) {
  const auth = sessions.requireAdmin(sessionToken(request, 'admin'), 'system.manage');
  if (requireCsrf) sessions.verifyCsrf(auth.session, request.headers['x-csrf-token']);
  invariant(auth.admin.is_owner || auth.admin.role === 'owner' || auth.admin.role === 'super_admin',
    'MIGRATION_OWNER_REQUIRED', '只有平台所有者可以管理系统迁移', 403);
  return auth.session;
}

function serveStatic(pathname, response) {
  const routeMap = {
    '/': 'index.html',
    '/build': 'build.html',
    '/admin': 'admin.html',
  };
  const relative = routeMap[pathname] ?? pathname.replace(/^\/+/, '');
  const file = resolve(PUBLIC_ROOT, relative);
  if (!(file === PUBLIC_ROOT || file.startsWith(`${PUBLIC_ROOT}${sep}`)) || !existsSync(file) || !statSync(file).isFile()) return false;
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  response.writeHead(200, {
    ...securityHeaders(type),
    'cache-control': 'no-store',
    'content-length': statSync(file).size,
  });
  createReadStream(file).pipe(response);
  return true;
}

function publicCorsHeaders(request) {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const releaseFeed = pathname === '/api/v1/releases/latest';
  if (!releaseFeed && pathname !== '/api/v1/installation-challenges' && pathname !== '/api/v1/install-unlocks' && pathname !== '/api/v1/activations' && pathname !== '/api/v1/activations/refresh' && pathname !== '/api/v1/product-migrations') return {};
  const origin = request.headers.origin;
  if (!origin) return {};
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol)) return {};
  } catch {
    return {};
  }
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': releaseFeed ? 'GET, OPTIONS' : 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

function createRateLimiter() {
  const buckets = new Map();
  return function check(key, limit, windowMs) {
    const now = Date.now();
    const current = buckets.get(key);
    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return;
    }
    current.count += 1;
    if (current.count > limit) throw new DomainError('RATE_LIMITED', '请求过于频繁，请稍后再试', 429);
  };
}

export function createHttpHandler({ service, sessions, portal, updates, migrations, artifactStore, config, publicKey, publicKeys = null }) {
  const rateLimit = createRateLimiter();
  function nodeFromToken(request, role) {
    return portal.authenticateServiceNode(bearer(request), role);
  }

  function workerIdentity(request, requestedId) {
    const node = nodeFromToken(request, 'worker');
    if (node) return node.id;
    requireToken(request, config.workerToken, '构建 Worker');
    invariant(requestedId?.trim(), 'WORKER_ID_REQUIRED', '必须提供 Worker ID');
    return requestedId.trim();
  }

  return async function handler(request, response) {
    const corsHeaders = publicCorsHeaders(request);
    try {
      const url = new URL(request.url, config.publicBaseUrl);
      const method = request.method ?? 'GET';
      const sessionRoute = url.pathname === '/web/session' || url.pathname === '/web/logout';
      const sessionActor = sessionRoute ? url.searchParams.get('actor') : null;
      if (sessionRoute) invariant(sessionActor === 'admin' || sessionActor === 'customer', 'ACTOR_INVALID', '会话身份无效', 400);

      if (config.surface === 'license-center') {
        const path = url.pathname;
        const customerRoute = path.startsWith('/web/customer/');
        const internalSession = sessionRoute && sessionActor === 'customer';
        const buildNode = nodeFromToken(request, 'build-center');
        const legacyInternal = config.internalServiceToken && safeEqual(request.headers['x-appgog-internal'], config.internalServiceToken);
        if ((customerRoute || internalSession) && !buildNode && !legacyInternal) {
          throw new DomainError('INTERNAL_AUTH_REQUIRED', '内部服务凭证无效', 403);
        }
        if (sessionRoute && sessionActor === 'admin' && request.headers['x-appgog-internal']) {
          throw new DomainError('ACTOR_INVALID', '打包中心不可访问管理员会话', 403);
        }
        if (path === '/') {
          response.writeHead(302, { location: '/admin' });
          response.end();
          return;
        }
        if (path === '/build' || path === '/build.html' || path === '/index.html') {
          throw new DomainError('NOT_FOUND', '页面不存在', 404);
        }
      }

      if (method === 'OPTIONS' && Object.keys(corsHeaders).length) {
        response.writeHead(204, { ...securityHeaders(), ...corsHeaders });
        return response.end();
      }

      if (method === 'GET' && url.pathname === '/health') {
        const health = portal.healthStatus();
        return json(response, 200, {
          ok: true,
          service: 'appgog-license-api',
          version: PACKAGE_VERSION,
          ...health,
        });
      }

      if (method === 'GET' && url.pathname === '/api/v1/public-key') {
        const resolvedKeys = publicKeys ?? { activation: publicKey, package: publicKey, notification: publicKey };
        return json(response, 200, {
          algorithm: 'Ed25519',
          public_key: resolvedKeys.activation,
          public_keys: resolvedKeys,
        });
      }

      if (method === 'GET' && url.pathname === '/api/v1/releases/latest') {
        const product = url.searchParams.get('product') ?? 'appgog';
        invariant(product === 'appgog', 'PRODUCT_NOT_FOUND', '产品不存在', 404);
        return json(response, 200, service.releaseAnnouncement(product), corsHeaders);
      }

      if (await handleControlMigrationHttp({
        method, url, request, response, migrations,
        rateLimit: (key, limit, windowMs) => rateLimit(`${key}:${clientAddress(request)}`, limit, windowMs),
        readJson, bearer, respondJson: json,
        requireOwnerSession: (incoming, requireCsrf) => requireOwnerWebSession(incoming, sessions, requireCsrf),
      })) return;

      const requireAdminSession = (requireCsrf, permission = null) => requireWebSession(request, sessions, 'admin', requireCsrf, permission);
      if (await handleAdminAccountHttp({
        method, url, request, response, portal, readJson, respondJson: json,
        requireSession: requireAdminSession, clearAdminCookie: () => clearCookieHeader(config, 'admin'),
      })) return;
      if (await handleOperationsHttp({
        method, url, request, response, portal, updates, readJson, respondJson: json,
        requireSession: requireAdminSession,
      })) return;
      const scopedRateLimit = (key, limit, windowMs) => rateLimit(`${key}:${clientAddress(request)}`, limit, windowMs);
      if (await handlePackagingHttp({
        method, url, request, response, service, portal, config, readJson, readBuffer,
        respondJson: json, requireToken, workerIdentity,
        zipHeaders: () => securityHeaders('application/zip'), rateLimit: scopedRateLimit,
      })) return;
      if (await handleActivationHttp({
        method, url, request, response, service, portal, readJson, respondJson: json,
        corsHeaders, rateLimit: scopedRateLimit,
      })) return;
      if (await handleSupportHttp({
        method, url, request, response, portal, sessions, readJson, readBuffer,
        respondJson: json, requireWebSession, securityHeaders,
      })) return;

      if (method === 'POST' && url.pathname === '/web/customer/login') {
        invariant(portal.serviceEnabled('build_center_enabled') && portal.serviceEnabled('customer_login_enabled'),
          'BUILD_CENTER_MAINTENANCE', '客户打包中心正在维护', 503);
        rateLimit(`customer-login:${clientAddress(request)}`, 12, 15 * 60 * 1000);
        const body = await readJson(request);
        const result = sessions.loginCustomer(body.license_key);
        return json(response, 200, {
          actor: 'customer', csrf_token: result.csrfToken,
          license: { product: result.license.product_code, key_prefix: result.license.key_prefix },
        }, { 'set-cookie': cookieHeader(result.token, config, 'customer') });
      }

      if (method === 'POST' && url.pathname === '/web/admin/login') {
        rateLimit(`admin-login:${clientAddress(request)}`, 8, 15 * 60 * 1000);
        const body = await readJson(request);
        const result = sessions.loginAdmin(body.username, body.password, clientAddress(request));
        return json(response, 200, { actor: 'admin', id: result.admin.id, username: result.admin.username,
          display_name: result.admin.display_name, role: result.admin.role, permissions: result.admin.permissions,
          is_owner: Boolean(result.admin.is_owner), csrf_token: result.csrfToken }, {
          'set-cookie': cookieHeader(result.token, config, 'admin'),
        });
      }

      if (method === 'GET' && url.pathname === '/web/session') {
        const token = sessionToken(request, sessionActor);
        const session = sessions.requireActor(token, sessionActor);
        if (sessionActor === 'admin') {
          const { admin, permissions } = sessions.requireAdmin(token);
          return json(response, 200, { actor: 'admin', id: admin.id, username: admin.username, display_name: admin.display_name,
            role: admin.role, is_owner: Boolean(admin.is_owner), permissions, csrf_token: session.csrf_token });
        }
        return json(response, 200, { actor: sessionActor, csrf_token: session.csrf_token });
      }

      if (method === 'POST' && url.pathname === '/web/logout') {
        const token = sessionToken(request, sessionActor);
        const session = sessions.requireActor(token, sessionActor);
        sessions.verifyCsrf(session, request.headers['x-csrf-token']);
        sessions.logout(token);
        return json(response, 200, { ok: true }, { 'set-cookie': clearCookieHeader(config, sessionActor) });
      }

      if (method === 'GET' && url.pathname === '/web/customer/overview') {
        invariant(portal.serviceEnabled('build_center_enabled'), 'BUILD_CENTER_MAINTENANCE', '客户打包中心正在维护', 503);
        const session = requireWebSession(request, sessions, 'customer');
        return json(response, 200, portal.customerOverview(session));
      }

      if (method === 'POST' && url.pathname === '/web/customer/builds') {
        invariant(portal.serviceEnabled('build_center_enabled') && portal.serviceEnabled('new_builds_enabled'),
          'NEW_BUILDS_DISABLED', '当前暂停接收新构建', 503);
        const session = requireWebSession(request, sessions, 'customer', true);
        const body = await readJson(request);
        return json(response, 201, portal.enqueueCustomerBuild(session, body));
      }

      if (method === 'POST' && url.pathname === '/web/customer/domain/bind') {
        const session = requireWebSession(request, sessions, 'customer', true);
        const body = await readJson(request);
        return json(response, 200, portal.bindCustomerDomain(session, body));
      }

      if (method === 'POST' && url.pathname === '/web/customer/domain-migrations') {
        const session = requireWebSession(request, sessions, 'customer', true);
        const body = await readJson(request);
        return json(response, 201, portal.requestCustomerDomainMigration(session, body));
      }

      const customerBuildMatch = url.pathname.match(/^\/web\/customer\/builds\/([^/]+)$/);
      if (method === 'GET' && customerBuildMatch) {
        const session = requireWebSession(request, sessions, 'customer');
        return json(response, 200, portal.buildDetails(session, customerBuildMatch[1]));
      }

      const customerDownloadMatch = url.pathname.match(/^\/web\/customer\/builds\/([^/]+)\/download$/);
      const customerDownloadTicketMatch = url.pathname.match(/^\/web\/customer\/builds\/([^/]+)\/download-ticket$/);
      if (method === 'POST' && customerDownloadTicketMatch) {
        const session = requireWebSession(request, sessions, 'customer', true);
        portal.artifactForDownload(session, customerDownloadTicketMatch[1]);
        rateLimit(`download-ticket:${session.id}`, 60, 15 * 60 * 1000);
        const ticket = issueDownloadTicket(config, session, customerDownloadTicketMatch[1]);
        return json(response, 201, {
          download_url: `/web/customer/builds/${encodeURIComponent(customerDownloadTicketMatch[1])}/download?ticket=${encodeURIComponent(ticket.token)}`,
          expires_at: ticket.expiresAt,
        });
      }

      if (method === 'GET' && customerDownloadMatch) {
        const session = requireWebSession(request, sessions, 'customer');
        verifyDownloadTicket(config, url.searchParams.get('ticket'), session, customerDownloadMatch[1]);
        const artifact = portal.artifactForDownload(session, customerDownloadMatch[1]);
        const size = artifactStore.size(artifact.key);
        response.writeHead(200, {
          ...securityHeaders('application/zip'),
          'content-length': size,
          'content-disposition': `attachment; filename="${artifact.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
          'x-appgog-sha256': artifact.sha256,
        });
        return artifactStore.open(artifact.key).pipe(response);
      }

      if (method === 'GET' && url.pathname === '/web/admin/overview') {
        const admin = sessions.requireAdmin(sessionToken(request, 'admin'), 'dashboard.view');
        const overview = portal.adminOverview();
        if (!admin.permissions.includes('*')) {
          if (!admin.permissions.includes('license.view')) {
            overview.licenses = [];
            overview.domain_migrations = [];
          }
          if (!admin.permissions.includes('version.view')) overview.versions = [];
          if (!admin.permissions.includes('build.view')) overview.builds = [];
          if (!admin.permissions.includes('activation.view')) overview.activations = [];
          if (!admin.permissions.includes('audit.view')) overview.audit = [];
          if (!admin.permissions.includes('ticket.view')) overview.tickets = [];
          if (!admin.permissions.includes('admin.manage')) overview.admins = [];
          if (!admin.permissions.includes('system.manage')) overview.cms = null;
        }
        return json(response, 200, overview);
      }

      if (method === 'POST' && url.pathname === '/web/admin/licenses') {
        const admin = requireWebSession(request, sessions, 'admin', true, 'license.issue');
        const body = await readJson(request);
        const result = service.issueLicense({
          productCode: body.product_code, customerRef: body.customer_ref,
          domain: body.domain, updateUntil: body.update_until,
          planCode: body.plan_code,
          maxBuildsPerDay: body.max_builds_per_day,
          maxActivations: body.max_activations,
          actorId: admin.actor_id,
        });
        return json(response, 201, {
          license_id: result.license.id, license_key: result.licenseKey,
          bound_domain: result.license.bound_domain,
        });
      }

      if (method === 'POST' && url.pathname === '/web/admin/versions') {
        requireWebSession(request, sessions, 'admin', true, 'version.publish');
        const body = await readJson(request);
        const version = portal.registerSourceVersion({
          productCode: body.product_code, version: body.version,
          displayName: body.display_name, releaseNotes: body.release_notes, channel: body.channel,
          releaseKind: body.release_kind,
        });
        return json(response, 201, {
          id: version.id, version: version.version, display_name: version.display_name,
          source_kind: version.source_kind, status: version.status,
        });
      }

      if (method === 'POST' && url.pathname === '/web/admin/versions/upload') {
        const admin = requireWebSession(request, sessions, 'admin', true, 'version.publish');
        invariant(request.headers['content-type'] === 'application/zip', 'SOURCE_CONTENT_TYPE_INVALID', '请上传 ZIP 文件', 415);
        const zipBuffer = await readBuffer(request, config.maxSourceUploadBytes);
        const version = portal.publishSourceVersion({
          productCode: url.searchParams.get('product_code') || 'appgog',
          version: url.searchParams.get('version'),
          displayName: url.searchParams.get('display_name'),
          sourceFilename: url.searchParams.get('source_filename'),
          releaseNotes: url.searchParams.get('release_notes'), channel: url.searchParams.get('channel'),
          releaseKind: url.searchParams.get('release_kind'),
          actorId: admin.actor_id,
          zipBuffer,
        });
        return json(response, 201, {
          id: version.id, version: version.version, display_name: version.display_name,
          status: version.status, source_kind: version.source_kind,
        });
      }

      const withdrawMatch = url.pathname.match(/^\/web\/admin\/versions\/([^/]+)\/withdraw$/);
      if (method === 'POST' && withdrawMatch) {
        const session = requireWebSession(request, sessions, 'admin', true, 'version.manage');
        const body = await readJson(request);
        const version = portal.withdrawSourceVersion({ id: withdrawMatch[1], reason: body.reason, actorId: session.actor_id });
        return json(response, 200, { id: version.id, version: version.version, status: version.status, withdrawn_reason: version.withdrawn_reason });
      }

      const webRotateMatch = url.pathname.match(/^\/web\/admin\/licenses\/([^/]+)\/rotate-key$/);
      if (method === 'POST' && webRotateMatch) {
        const admin = requireWebSession(request, sessions, 'admin', true, 'license.manage');
        const result = service.rotateLicenseKey({ licenseId: webRotateMatch[1], actorId: admin.actor_id });
        return json(response, 200, {
          license_id: result.license.id, license_key: result.licenseKey,
          generation: result.license.generation,
        });
      }

      const webRevealMatch = url.pathname.match(/^\/web\/admin\/licenses\/([^/]+)\/key$/);
      if (method === 'POST' && webRevealMatch) {
        rateLimit(`license-key-reveal:${clientAddress(request)}`, 8, 15 * 60 * 1000);
        const auth = sessions.requireAdmin(sessionToken(request, 'admin'), 'license.manage');
        sessions.verifyCsrf(auth.session, request.headers['x-csrf-token']);
        invariant(auth.admin.is_owner || auth.admin.role === 'owner' || auth.admin.role === 'super_admin', 'LICENSE_KEY_REVEAL_FORBIDDEN', '只有平台所有者可以查看完整 Key', 403);
        const body = await readJson(request);
        invariant(verifyPassword(String(body.password ?? ''), auth.admin.password_hash), 'ADMIN_PASSWORD_CURRENT_INVALID', '当前管理员密码不正确', 403);
        const result = service.revealLicenseKey({ licenseId: webRevealMatch[1], actorId: auth.admin.id });
        return json(response, 200, { license_id: result.license.id, license_key: result.licenseKey });
      }

      const webDomainMatch = url.pathname.match(/^\/web\/admin\/licenses\/([^/]+)\/domain$/);
      if (method === 'POST' && webDomainMatch) {
        const admin = requireWebSession(request, sessions, 'admin', true, 'license.manage');
        const body = await readJson(request);
        const license = service.changeLicenseDomain({ licenseId: webDomainMatch[1], domain: body.domain, actorId: admin.actor_id });
        return json(response, 200, { license_id: license.id, bound_domain: license.bound_domain, generation: license.generation });
      }

      const webPlanMatch = url.pathname.match(/^\/web\/admin\/licenses\/([^/]+)\/plan$/);
      if (method === 'POST' && webPlanMatch) {
        const admin = requireWebSession(request, sessions, 'admin', true, 'license.manage');
        const body = await readJson(request);
        const license = service.changeLicensePlan({ licenseId: webPlanMatch[1], planCode: body.plan_code, actorId: admin.actor_id });
        return json(response, 200, {
          license_id: license.id, plan_code: license.plan_code, generation: license.generation,
        });
      }

      const webDeleteLicenseMatch = url.pathname.match(/^\/web\/admin\/licenses\/([^/]+)$/);
      if (method === 'DELETE' && webDeleteLicenseMatch) {
        rateLimit(`license-delete:${clientAddress(request)}`, 5, 15 * 60 * 1000);
        const auth = sessions.requireAdmin(sessionToken(request, 'admin'), 'license.manage');
        sessions.verifyCsrf(auth.session, request.headers['x-csrf-token']);
        invariant(auth.admin.is_owner || auth.admin.role === 'owner' || auth.admin.role === 'super_admin', 'LICENSE_DELETE_FORBIDDEN', '只有平台所有者可以永久删除授权', 403);
        const body = await readJson(request);
        invariant(verifyPassword(String(body.password ?? ''), auth.admin.password_hash), 'ADMIN_PASSWORD_CURRENT_INVALID', '当前管理员密码不正确', 403);
        invariant(String(body.confirmation ?? '') === `DELETE ${webDeleteLicenseMatch[1]}`, 'LICENSE_DELETE_CONFIRMATION_INVALID', '永久删除确认文本不正确', 400);
        return json(response, 200, portal.deleteLicensePermanently({
          licenseId: webDeleteLicenseMatch[1], actorId: auth.admin.id,
        }));
      }

      const domainMigrationReviewMatch = url.pathname.match(/^\/web\/admin\/domain-migrations\/([^/]+)\/review$/);
      if (method === 'POST' && domainMigrationReviewMatch) {
        const admin = requireWebSession(request, sessions, 'admin', true, 'license.manage');
        const body = await readJson(request);
        return json(response, 200, portal.reviewDomainMigration({
          requestId: domainMigrationReviewMatch[1],
          decision: body.decision,
          reviewNote: body.review_note,
          actorId: admin.actor_id,
        }));
      }

      const webStatusMatch = url.pathname.match(/^\/web\/admin\/licenses\/([^/]+)\/status$/);
      if (method === 'POST' && webStatusMatch) {
        const admin = requireWebSession(request, sessions, 'admin', true, 'license.manage');
        const body = await readJson(request);
        const license = service.changeLicenseStatus({ licenseId: webStatusMatch[1], status: body.status, actorId: admin.actor_id });
        return json(response, 200, { license_id: license.id, status: license.status });
      }

      if (method === 'POST' && url.pathname === '/api/v1/admin/licenses') {
        requireToken(request, config.adminToken, '管理员');
        const body = await readJson(request);
        const result = service.issueLicense({
          productCode: body.product_code, customerRef: body.customer_ref,
          domain: body.domain, updateUntil: body.update_until,
          planCode: body.plan_code,
          maxBuildsPerDay: body.max_builds_per_day,
          maxActivations: body.max_activations,
        });
        return json(response, 201, {
          license_id: result.license.id, license_key: result.licenseKey,
          product: result.license.product_code,
          bound_domain: result.license.bound_domain,
          generation: result.license.generation,
        });
      }

      const rotateMatch = url.pathname.match(/^\/api\/v1\/admin\/licenses\/([^/]+)\/rotate-key$/);
      if (method === 'POST' && rotateMatch) {
        requireToken(request, config.adminToken, '管理员');
        const result = service.rotateLicenseKey({ licenseId: rotateMatch[1] });
        return json(response, 200, {
          license_id: result.license.id, license_key: result.licenseKey,
          generation: result.license.generation,
        });
      }

      if (method === 'GET' && serveStatic(url.pathname, response)) return undefined;
      return json(response, 404, { error: { code: 'NOT_FOUND', message: '接口或页面不存在' } });
    } catch (error) {
      const known = error instanceof DomainError;
      if (!known) console.error(error);
      return json(response, known ? error.status : 500, {
        error: {
          code: known ? error.code : 'INTERNAL_ERROR',
          message: known ? error.message : '服务内部错误',
          ...(known && error.details ? { details: error.details } : {}),
        },
      }, corsHeaders);
    }
  };
}

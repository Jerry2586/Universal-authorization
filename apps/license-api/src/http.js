import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { DomainError, invariant } from '../../../packages/core/src/errors.js';
import { hashPassword, verifyPassword } from '../../../packages/core/src/password.js';
import { hashSecret } from '../../../packages/core/src/security.js';
import { ADMIN_ROLES } from './admin-policy.js';

const PUBLIC_ROOT = resolve(process.cwd(), 'apps/web/public');
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
    'cache-control': type.startsWith('text/html') ? 'no-store' : 'public, max-age=300',
    'content-length': statSync(file).size,
  });
  createReadStream(file).pipe(response);
  return true;
}

function publicCorsHeaders(request) {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const releaseFeed = pathname === '/api/v1/releases/latest';
  if (!releaseFeed && pathname !== '/api/v1/activations' && pathname !== '/api/v1/activations/refresh') return {};
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

export function createHttpHandler({ service, sessions, portal, artifactStore, config, publicKey }) {
  const rateLimit = createRateLimiter();
  function nodeFromToken(request, role) {
    const token = bearer(request);
    if (!token) return null;
    let node = null;
    try { node = portal.repository.serviceNodeByCredentialHash(hashSecret(token, config.pepper)); } catch { return null; }
    if (!node || node.role !== role || node.status !== 'active') return null;
    return portal.repository.touchServiceNode(node.id, new Date().toISOString());
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
        return json(response, 200, { ok: true, service: 'appgog-license-api', version: 1 });
      }

      if (method === 'GET' && url.pathname === '/api/v1/public-key') {
        return json(response, 200, { algorithm: 'Ed25519', public_key: publicKey });
      }

      if (method === 'GET' && url.pathname === '/api/v1/releases/latest') {
        const product = url.searchParams.get('product') ?? 'appgog';
        invariant(product === 'appgog', 'PRODUCT_NOT_FOUND', '产品不存在', 404);
        return json(response, 200, service.releaseAnnouncement(product), corsHeaders);
      }

      if (method === 'POST' && url.pathname === '/web/customer/login') {
        invariant(portal.serviceEnabled('build_center_enabled') && portal.serviceEnabled('customer_login_enabled'),
          'BUILD_CENTER_MAINTENANCE', '客户打包中心正在维护', 503);
        rateLimit(`customer-login:${request.socket.remoteAddress}`, 12, 15 * 60 * 1000);
        const body = await readJson(request);
        const result = sessions.loginCustomer(body.license_key);
        return json(response, 200, {
          actor: 'customer', csrf_token: result.csrfToken,
          license: { product: result.license.product_code, key_prefix: result.license.key_prefix },
        }, { 'set-cookie': cookieHeader(result.token, config, 'customer') });
      }

      if (method === 'POST' && url.pathname === '/web/admin/login') {
        rateLimit(`admin-login:${request.socket.remoteAddress}`, 8, 15 * 60 * 1000);
        const body = await readJson(request);
        const result = sessions.loginAdmin(body.username, body.password, request.socket.remoteAddress);
        return json(response, 200, { actor: 'admin', username: result.admin.username,
          display_name: result.admin.display_name, role: result.admin.role, permissions: result.admin.permissions,
          csrf_token: result.csrfToken }, {
          'set-cookie': cookieHeader(result.token, config, 'admin'),
        });
      }

      if (method === 'GET' && url.pathname === '/web/session') {
        const token = sessionToken(request, sessionActor);
        const session = sessions.requireActor(token, sessionActor);
        if (sessionActor === 'admin') {
          const { admin, permissions } = sessions.requireAdmin(token);
          return json(response, 200, { actor: 'admin', username: admin.username, display_name: admin.display_name,
            role: admin.role, permissions, csrf_token: session.csrf_token });
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

      const customerBuildMatch = url.pathname.match(/^\/web\/customer\/builds\/([^/]+)$/);
      if (method === 'GET' && customerBuildMatch) {
        const session = requireWebSession(request, sessions, 'customer');
        return json(response, 200, portal.buildDetails(session, customerBuildMatch[1]));
      }

      const customerDownloadMatch = url.pathname.match(/^\/web\/customer\/builds\/([^/]+)\/download$/);
      if (method === 'GET' && customerDownloadMatch) {
        const session = requireWebSession(request, sessions, 'customer');
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
          if (!admin.permissions.includes('license.view')) overview.licenses = [];
          if (!admin.permissions.includes('version.view')) overview.versions = [];
          if (!admin.permissions.includes('build.view')) overview.builds = [];
          if (!admin.permissions.includes('activation.view')) overview.activations = [];
          if (!admin.permissions.includes('audit.view')) overview.audit = [];
          if (!admin.permissions.includes('admin.manage')) overview.admins = [];
          if (!admin.permissions.includes('system.manage')) overview.cms = null;
        }
        return json(response, 200, overview);
      }

      if (method === 'POST' && url.pathname === '/web/admin/cms/settings') {
        const session = requireWebSession(request, sessions, 'admin', true, 'system.manage');
        const body = await readJson(request);
        return json(response, 200, portal.updateCmsSettings(body, session.actor_id));
      }

      if (method === 'POST' && url.pathname === '/web/admin/cms/nodes') {
        const session = requireWebSession(request, sessions, 'admin', true, 'system.manage');
        const body = await readJson(request);
        const result = portal.createServiceNode(body, session.actor_id);
        return json(response, 201, { ...result.node, node_credential: result.credential });
      }

      const nodeStatusMatch = url.pathname.match(/^\/web\/admin\/cms\/nodes\/([^/]+)\/status$/);
      if (method === 'POST' && nodeStatusMatch) {
        const session = requireWebSession(request, sessions, 'admin', true, 'system.manage');
        const body = await readJson(request);
        return json(response, 200, portal.changeServiceNodeStatus(nodeStatusMatch[1], body.status, session.actor_id));
      }

      const nodeRotateMatch = url.pathname.match(/^\/web\/admin\/cms\/nodes\/([^/]+)\/rotate$/);
      if (method === 'POST' && nodeRotateMatch) {
        const session = requireWebSession(request, sessions, 'admin', true, 'system.manage');
        const result = portal.rotateServiceNodeCredential(nodeRotateMatch[1], session.actor_id);
        return json(response, 200, { ...result.node, node_credential: result.credential });
      }

      if (method === 'POST' && url.pathname === '/web/admin/admins') {
        const session = requireWebSession(request, sessions, 'admin', true, 'admin.manage');
        const body = await readJson(request);
        invariant(/^[a-zA-Z][a-zA-Z0-9_.-]{2,39}$/.test(body.username ?? ''), 'ADMIN_USERNAME_INVALID', '管理员账号必须为 3–40 位字母、数字、点、下划线或短横线');
        invariant(typeof body.password === 'string' && body.password.length >= 12, 'ADMIN_PASSWORD_WEAK', '管理员密码至少 12 个字符');
        invariant(ADMIN_ROLES.includes(body.role) && body.role !== 'owner' && body.role !== 'super_admin', 'ADMIN_ROLE_INVALID', '只能创建非最高权限的管理员');
        invariant(!portal.repository.adminByUsername(body.username), 'ADMIN_EXISTS', '管理员账号已存在', 409);
        const admin = portal.repository.createAdmin({ username: body.username, displayName: String(body.display_name ?? body.username).slice(0, 80),
          passwordHash: hashPassword(body.password), role: body.role, now: new Date().toISOString() });
        portal.repository.audit({ actorType: 'admin', actorId: session.actor_id, action: 'admin.created',
          subjectType: 'admin', subjectId: admin.id, metadata: { username: admin.username, role: admin.role }, now: new Date().toISOString() });
        return json(response, 201, { id: admin.id, username: admin.username, display_name: admin.display_name, role: admin.role, status: admin.status });
      }

      const adminStatusMatch = url.pathname.match(/^\/web\/admin\/admins\/([^/]+)\/status$/);
      if (method === 'POST' && adminStatusMatch) {
        const session = requireWebSession(request, sessions, 'admin', true, 'admin.manage');
        const body = await readJson(request);
        invariant(['active', 'suspended'].includes(body.status), 'ADMIN_STATUS_INVALID', '管理员状态无效');
        invariant(session.actor_id !== adminStatusMatch[1], 'ADMIN_SELF_STATUS', '不能停用自己的账号', 403);
        const admin = portal.repository.changeAdminStatus(adminStatusMatch[1], body.status, new Date().toISOString());
        invariant(admin, 'ADMIN_PROTECTED', '管理员不存在或受到保护', 403);
        if (body.status === 'suspended') portal.repository.revokeAdminSessions(admin.id);
        portal.repository.audit({ actorType: 'admin', actorId: session.actor_id, action: `admin.${body.status}`,
          subjectType: 'admin', subjectId: admin.id, now: new Date().toISOString() });
        return json(response, 200, { id: admin.id, status: admin.status });
      }

      if (method === 'POST' && url.pathname === '/web/admin/licenses') {
        const admin = requireWebSession(request, sessions, 'admin', true, 'license.issue');
        const body = await readJson(request);
        const result = service.issueLicense({
          productCode: body.product_code, customerRef: body.customer_ref,
          domain: body.domain, updateUntil: body.update_until,
          maxBuildsPerDay: body.max_builds_per_day,
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
          releaseKind: body.release_kind, minXboardVersion: body.min_xboard_version,
          minUpgradeVersion: body.min_upgrade_version, rollbackAllowed: body.rollback_allowed,
          rollbackTo: body.rollback_to,
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
          releaseNotes: url.searchParams.get('release_notes'), channel: url.searchParams.get('channel'),
          releaseKind: url.searchParams.get('release_kind'), minXboardVersion: url.searchParams.get('min_xboard_version'),
          minUpgradeVersion: url.searchParams.get('min_upgrade_version'), rollbackAllowed: url.searchParams.get('rollback_allowed') !== 'false',
          rollbackTo: url.searchParams.get('rollback_to'),
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

      const webDomainMatch = url.pathname.match(/^\/web\/admin\/licenses\/([^/]+)\/domain$/);
      if (method === 'POST' && webDomainMatch) {
        const admin = requireWebSession(request, sessions, 'admin', true, 'license.manage');
        const body = await readJson(request);
        const license = service.changeLicenseDomain({ licenseId: webDomainMatch[1], domain: body.domain, actorId: admin.actor_id });
        return json(response, 200, { license_id: license.id, bound_domain: license.bound_domain, generation: license.generation });
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
          maxBuildsPerDay: body.max_builds_per_day,
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

      if (method === 'POST' && url.pathname === '/api/v1/builds/authorize') {
        const body = await readJson(request);
        const result = service.authorizeBuild({ licenseKey: body.license_key, version: body.version, domain: body.domain });
        return json(response, 201, {
          build_ticket: result.buildTicket, ticket_id: result.ticketId,
          expires_at: result.expiresAt, product: result.product,
        });
      }

      if (method === 'POST' && url.pathname === '/api/v1/worker/builds/claim') {
        requireToken(request, config.workerToken, '构建 Worker');
        const body = await readJson(request);
        const result = service.claimBuild({
          buildTicket: body.build_ticket, artifactSha256: body.artifact_sha256,
          installKeyTtlSeconds: body.install_key_ttl_seconds,
        });
        return json(response, 201, {
          build_id: result.buildId, product: result.product, version: result.version,
          domain: result.domain, package_id: result.packageId,
          package_secret: result.packageSecret, install_key: result.installKey,
        });
      }

      if (method === 'POST' && url.pathname === '/api/v1/worker/jobs/lease') {
        invariant(portal.serviceEnabled('worker_enabled'), 'WORKER_DISABLED', '构建 Worker 服务已暂停', 503);
        const body = await readJson(request);
        const workerId = workerIdentity(request, body.worker_id);
        const leased = portal.leaseBuild(workerId);
        return json(response, 200, { task: leased });
      }

      const progressMatch = url.pathname.match(/^\/api\/v1\/worker\/jobs\/([^/]+)\/progress$/);
      if (method === 'POST' && progressMatch) {
        const body = await readJson(request);
        const workerId = workerIdentity(request, body.worker_id);
        return json(response, 200, portal.updateBuildProgress(workerId, progressMatch[1], body));
      }

      const sourceMatch = url.pathname.match(/^\/api\/v1\/worker\/jobs\/([^/]+)\/source$/);
      if (method === 'GET' && sourceMatch) {
        const workerId = workerIdentity(request, url.searchParams.get('worker_id'));
        const buffer = portal.sourceForWorker(workerId, sourceMatch[1]);
        response.writeHead(200, { ...securityHeaders('application/zip'), 'content-length': buffer.length });
        return response.end(buffer);
      }

      const artifactMatch = url.pathname.match(/^\/api\/v1\/worker\/jobs\/([^/]+)\/artifact$/);
      if (method === 'PUT' && artifactMatch) {
        const workerId = workerIdentity(request, url.searchParams.get('worker_id'));
        invariant(request.headers['content-type'] === 'application/zip', 'ARTIFACT_CONTENT_TYPE_INVALID', '构建成品必须为 ZIP', 415);
        const buffer = await readBuffer(request, config.maxSourceUploadBytes);
        return json(response, 201, portal.saveWorkerArtifact(workerId, artifactMatch[1], buffer));
      }

      const completeMatch = url.pathname.match(/^\/api\/v1\/worker\/jobs\/([^/]+)\/complete$/);
      if (method === 'POST' && completeMatch) {
        const body = await readJson(request);
        const workerId = workerIdentity(request, body.worker_id);
        return json(response, 200, portal.completeBuild(workerId, completeMatch[1], body));
      }

      const failMatch = url.pathname.match(/^\/api\/v1\/worker\/jobs\/([^/]+)\/fail$/);
      if (method === 'POST' && failMatch) {
        const body = await readJson(request);
        const workerId = workerIdentity(request, body.worker_id);
        return json(response, 200, portal.failBuild(workerId, failMatch[1], body));
      }

      if (method === 'POST' && url.pathname === '/api/v1/activations') {
        invariant(portal.serviceEnabled('license_service_enabled'), 'LICENSE_SERVICE_MAINTENANCE', '授权服务正在维护', 503);
        rateLimit(`activate:${request.socket.remoteAddress}`, 30, 15 * 60 * 1000);
        const body = await readJson(request);
        const result = service.activate({
          installKey: body.install_key, licenseKey: body.license_key, buildId: body.build_id,
          packageProof: body.package_proof, domain: body.domain,
          backendUrl: body.backend_url, installationId: body.installation_id,
        });
        return json(response, 201, {
          activation_id: result.activationId, activation_token: result.token,
          refresh_secret: result.refreshSecret, expires_at: result.expiresAt,
        }, corsHeaders);
      }

      if (method === 'POST' && url.pathname === '/api/v1/activations/refresh') {
        invariant(portal.serviceEnabled('license_service_enabled'), 'LICENSE_SERVICE_MAINTENANCE', '授权服务正在维护', 503);
        rateLimit(`refresh:${request.socket.remoteAddress}`, 120, 15 * 60 * 1000);
        const body = await readJson(request);
        const result = service.refresh({
          activationId: body.activation_id, refreshSecret: body.refresh_secret,
          domain: body.domain, installationId: body.installation_id, backendUrl: body.backend_url,
        });
        return json(response, 200, { activation_token: result.token, expires_at: result.expiresAt }, corsHeaders);
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

import { PACKAGE_VERSION } from '../../../packages/core/src/version.js';
import { DomainError } from '../../../packages/core/src/errors.js';
import { handleActivationHttp } from './modules/activation/http-routes.js';
import { handleAdminAccountHttp } from './modules/admin/http-routes.js';
import { handleAdminOverviewHttp } from './modules/admin/overview-http-routes.js';
import { handleCustomerHttp } from './modules/customer/http-routes.js';
import { handleIdentityHttp } from './modules/identity/http-routes.js';
import { handleEntitlementHttp } from './modules/entitlement/http-routes.js';
import { handleLicensingHttp } from './modules/licensing/http-routes.js';
import { handleControlMigrationHttp } from './modules/migration/http-routes.js';
import { handleOperationsHttp } from './modules/operations/http-routes.js';
import { handlePackagingHttp } from './modules/packaging/http-routes.js';
import { handleProductHttp } from './modules/product/http-routes.js';
import { handlePublicHttp } from './modules/public/http-routes.js';
import { handleSupportHttp } from './modules/support/http-routes.js';
import { createRequestAuth, bearer, safeEqual } from './http/middleware/auth.js';
import { readBuffer, readJson } from './http/middleware/body.js';
import { clientAddress } from './http/middleware/client-address.js';
import { publicCorsHeaders } from './http/middleware/cors.js';
import { respondError } from './http/middleware/error-handler.js';
import { createRateLimiter } from './http/middleware/rate-limit.js';
import { createRequestContext } from './http/middleware/request-context.js';
import { createJsonResponder, securityHeaders } from './http/middleware/response.js';
import { serveStatic } from './http/static.js';


function enforceSurfaceBoundary({ request, response, url, config, portal, auth }) {
  if (config.surface !== 'license-center') return false;
  const path = url.pathname;
  const sessionRoute = path === '/web/session' || path === '/web/logout';
  const sessionActor = sessionRoute ? url.searchParams.get('actor') : null;
  const customerRoute = path.startsWith('/web/customer/');
  const buildNode = portal.authenticateServiceNode(auth.bearer(), 'build-center');
  const legacyInternal = config.internalServiceToken
    && safeEqual(request.headers['x-appgog-internal'], config.internalServiceToken);
  if ((customerRoute || (sessionRoute && sessionActor === 'customer')) && !buildNode && !legacyInternal) {
    throw new DomainError('INTERNAL_AUTH_REQUIRED', '内部服务凭证无效', 403);
  }
  if (sessionRoute && sessionActor === 'admin' && request.headers['x-appgog-internal']) {
    throw new DomainError('ACTOR_INVALID', '打包中心不可访问管理员会话', 403);
  }
  if (path === '/') {
    response.writeHead(302, { location: '/admin' });
    response.end();
    return true;
  }
  if (path === '/build' || path === '/build.html' || path === '/index.html') {
    throw new DomainError('NOT_FOUND', '页面不存在', 404);
  }
  return false;
}

export function createHttpHandler({
  service, sessions, portal, updates, migrations, artifactStore, config, publicKey, publicKeys = null,
}) {
  const rateLimit = createRateLimiter();

  return async function handler(request, response) {
    const context = createRequestContext(request);
    const respondJson = createJsonResponder(context.requestId);
    const corsHeaders = publicCorsHeaders(request);
    response.setHeader('x-request-id', context.requestId);
    try {
      const url = new URL(request.url, config.publicBaseUrl);
      const method = request.method ?? 'GET';
      const auth = createRequestAuth({ request, sessions, config });
      const remoteAddress = clientAddress(request);
      const scopedRateLimit = (key, limit, windowMs) => rateLimit(`${key}:${remoteAddress}`, limit, windowMs);
      if (enforceSurfaceBoundary({ request, response, url, config, portal, auth })) return;

      if (method === 'OPTIONS' && Object.keys(corsHeaders).length) {
        response.writeHead(204, { ...securityHeaders(), ...corsHeaders });
        response.end();
        return;
      }

      if (await handlePublicHttp({
        method, url, response, portal, service, publicKey, publicKeys,
        packageVersion: PACKAGE_VERSION, respondJson, corsHeaders,
      })) return;
      if (await handleControlMigrationHttp({
        method, url, request, response, migrations, rateLimit: scopedRateLimit,
        readJson, bearer, respondJson, requireOwnerSession: (_incoming, csrf) => auth.requireOwner(csrf),
      })) return;

      const requireAdminSession = (csrf, permission = null) => auth.requireSession('admin', csrf, permission);
      if (await handleAdminAccountHttp({
        method, url, request, response, portal, readJson, respondJson,
        requireSession: requireAdminSession, clearAdminCookie: () => auth.clearCookieHeader('admin'),
      })) return;
      if (await handleOperationsHttp({
        method, url, request, response, portal, updates, readJson, respondJson, requireSession: requireAdminSession,
      })) return;

      const workerIdentity = (_incoming, requestedId) => {
        const node = portal.authenticateServiceNode(auth.bearer(), 'worker');
        if (node) return node.id;
        auth.requireToken(config.workerToken, '构建 Worker');
        if (!requestedId?.trim()) throw new DomainError('WORKER_ID_REQUIRED', '必须提供 Worker ID', 400);
        return requestedId.trim();
      };
      if (await handlePackagingHttp({
        method, url, request, response, service, portal, config, readJson, readBuffer, respondJson,
        requireToken: (_incoming, expected, role) => auth.requireToken(expected, role), workerIdentity,
        zipHeaders: () => securityHeaders('application/zip'), rateLimit: scopedRateLimit,
      })) return;
      if (await handleActivationHttp({
        method, url, request, response, service, portal, readJson, respondJson, corsHeaders, rateLimit: scopedRateLimit,
      })) return;
      if (await handleSupportHttp({
        method, url, request, response, portal, sessions, readJson, readBuffer, respondJson, securityHeaders,
        requireWebSession: (_incoming, _sessions, actor, csrf, permission) => auth.requireSession(actor, csrf, permission),
      })) return;
      if (await handleIdentityHttp({
        method, url, request, response, portal, sessions, auth, readJson, respondJson,
        rateLimit, clientAddress: remoteAddress,
      })) return;
      if (await handleCustomerHttp({
        method, url, request, response, portal, artifactStore, auth, config, readJson,
        respondJson, rateLimit, securityHeaders,
      })) return;
      if (await handleAdminOverviewHttp({ method, url, response, portal, auth, respondJson })) return;
      if (await handleEntitlementHttp({ method, url, request, response, service, auth, readJson, respondJson })) return;
      if (await handleLicensingHttp({
        method, url, request, response, service, portal, auth, config, readJson,
        respondJson, rateLimit, clientAddress: remoteAddress,
      })) return;
      if (await handleProductHttp({
        method, url, request, response, portal, auth, config, readJson, readBuffer, respondJson,
      })) return;

      if (method === 'GET' && serveStatic(url.pathname, response, context.requestId)) return;
      throw new DomainError('NOT_FOUND', '接口或页面不存在', 404);
    } catch (error) {
      respondError({ response, error, requestId: context.requestId, respondJson, headers: corsHeaders });
    }
  };
}

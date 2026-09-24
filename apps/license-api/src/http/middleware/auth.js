import { timingSafeEqual } from 'node:crypto';
import { DomainError, invariant } from '../../../../../packages/core/src/errors.js';

const SESSION_COOKIES = Object.freeze({ admin: 'appgog_admin_session', customer: 'appgog_customer_session' });

export function bearer(request) {
  const value = request.headers.authorization ?? '';
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

export function safeEqual(left, right) {
  const a = Buffer.from(left ?? '');
  const b = Buffer.from(right ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookies(request) {
  const output = {};
  for (const pair of String(request.headers.cookie ?? '').split(';')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    try {
      output[pair.slice(0, separator).trim()] = decodeURIComponent(pair.slice(separator + 1).trim());
    } catch {
      // Malformed cookies are treated as absent credentials.
    }
  }
  return output;
}

export function createRequestAuth({ request, sessions, config }) {
  const cookieValues = cookies(request);
  const sessionToken = (actor) => cookieValues[SESSION_COOKIES[actor]] ?? '';
  const secure = new URL(config.publicBaseUrl).protocol === 'https:' ? '; Secure' : '';

  return Object.freeze({
    bearer: () => bearer(request),
    requireToken(expected, role) {
      if (!safeEqual(bearer(request), expected)) throw new DomainError('UNAUTHORIZED', `${role} 凭证无效`, 401);
    },
    requireSession(actorType, requireCsrf = false, permission = null) {
      const session = actorType === 'admin'
        ? sessions.requireAdmin(sessionToken(actorType), permission).session
        : sessions.requireActor(sessionToken(actorType), actorType);
      if (requireCsrf) sessions.verifyCsrf(session, request.headers['x-csrf-token']);
      return session;
    },
    requireAdmin(requireCsrf = false, permission = null) {
      const auth = sessions.requireAdmin(sessionToken('admin'), permission);
      if (requireCsrf) sessions.verifyCsrf(auth.session, request.headers['x-csrf-token']);
      return auth;
    },
    requireOwner(requireCsrf = false) {
      const auth = sessions.requireAdmin(sessionToken('admin'), 'system.manage');
      if (requireCsrf) sessions.verifyCsrf(auth.session, request.headers['x-csrf-token']);
      invariant(auth.admin.is_owner || auth.admin.role === 'owner' || auth.admin.role === 'super_admin',
        'MIGRATION_OWNER_REQUIRED', '只有平台所有者可以管理系统迁移', 403);
      return auth.session;
    },
    sessionToken,
    cookieHeader(actor, token) {
      return `${SESSION_COOKIES[actor]}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${config.webSessionTtlSeconds}${secure}`;
    },
    clearCookieHeader(actor) {
      return `${SESSION_COOKIES[actor]}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`;
    },
  });
}

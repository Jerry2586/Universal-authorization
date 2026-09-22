import { DomainError, invariant } from '../../../packages/core/src/errors.js';
import { newCsrfToken, newId, newSessionToken } from '../../../packages/core/src/identifiers.js';
import { hashSecret } from '../../../packages/core/src/security.js';
import { verifyPassword } from '../../../packages/core/src/password.js';
import { adminCan, adminPermissions } from './admin-policy.js';

function addSeconds(date, seconds) {
  return new Date(date.getTime() + seconds * 1000).toISOString();
}

export function createSessionService({ repository, config, clock = () => new Date() }) {
  function create(actorType, actorId = null) {
    const token = newSessionToken();
    const csrfToken = newCsrfToken();
    const now = clock();
    repository.deleteExpiredSessions(now.toISOString());
    const session = repository.createSession({
      id: newId('ses'),
      tokenHash: hashSecret(token, config.sessionSecret),
      csrfToken,
      actorType,
      actorId,
      expiresAt: addSeconds(now, config.webSessionTtlSeconds),
      now: now.toISOString(),
    });
    return { session, token, csrfToken };
  }

  return {
    loginCustomer(licenseKey) {
      const license = repository.licenseByHash(hashSecret(licenseKey, config.pepper));
      invariant(license && license.status === 'active', 'LICENSE_LOGIN_FAILED', '固定 Key 无效或已停用', 401);
      return { ...create('customer', license.id), license };
    },

    loginAdmin(username, password, ip = null) {
      const admin = repository.adminByUsername(String(username ?? '').trim());
      invariant(admin && admin.status === 'active' && verifyPassword(String(password ?? ''), admin.password_hash), 'ADMIN_LOGIN_FAILED', '管理员账号或密码错误', 401);
      const current = repository.updateAdminLogin(admin.id, ip, clock().toISOString());
      return { ...create('admin', admin.id), admin: {
        id: current.id, username: current.username, display_name: current.display_name,
        role: current.role, permissions: adminPermissions(current), is_owner: Boolean(current.is_owner),
      } };
    },

    resolve(token) {
      if (!token) throw new DomainError('SESSION_REQUIRED', '请先登录', 401);
      const session = repository.sessionByHash(hashSecret(token, config.sessionSecret));
      invariant(session, 'SESSION_INVALID', '登录状态无效', 401);
      if (new Date(session.expires_at) < clock()) {
        repository.deleteSession(session.id);
        throw new DomainError('SESSION_EXPIRED', '登录已过期，请重新进入', 401);
      }
      repository.touchSession(session.id, clock().toISOString());
      return session;
    },

    requireActor(token, actorType) {
      const session = this.resolve(token);
      invariant(session.actor_type === actorType, 'FORBIDDEN', '当前登录身份无权访问', 403);
      return session;
    },

    requireAdmin(token, permission = null) {
      const session = this.requireActor(token, 'admin');
      const admin = repository.adminById(session.actor_id);
      invariant(admin && admin.status === 'active', 'ADMIN_INACTIVE', '管理员账号已停用', 403);
      if (permission) invariant(adminCan(admin, permission), 'ADMIN_PERMISSION_DENIED', '当前管理员没有此操作权限', 403);
      return { session, admin, permissions: adminPermissions(admin) };
    },

    verifyCsrf(session, csrfToken) {
      invariant(typeof csrfToken === 'string' && csrfToken === session.csrf_token, 'CSRF_INVALID', '页面安全令牌已失效，请刷新页面', 403);
    },

    logout(token) {
      if (!token) return;
      const session = repository.sessionByHash(hashSecret(token, config.sessionSecret));
      if (session) repository.deleteSession(session.id);
    },
  };
}

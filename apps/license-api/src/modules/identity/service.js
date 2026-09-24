import { invariant } from '../../../../../packages/core/src/errors.js';
import { hashPassword, verifyPassword } from '../../../../../packages/core/src/password.js';
import { ADMIN_ROLES } from '../../admin-policy.js';

export function createIdentityService({ repository, clock = () => new Date() }) {
  return {
    createAdminAccount(input, actorId) {
      const username = String(input.username ?? '').trim();
      invariant(/^[a-zA-Z][a-zA-Z0-9_.-]{2,39}$/.test(username), 'ADMIN_USERNAME_INVALID', '管理员账号必须为 3–40 位字母、数字、点、下划线或短横线');
      invariant(/^\d{6}$/.test(input.password ?? ''), 'ADMIN_PASSWORD_INVALID', '管理员初始密码必须是 6 位数字');
      invariant(ADMIN_ROLES.includes(input.role) && input.role !== 'owner' && input.role !== 'super_admin', 'ADMIN_ROLE_INVALID', '只能创建非最高权限的管理员');
      invariant(!repository.adminByUsername(username), 'ADMIN_EXISTS', '管理员账号已存在', 409);
      const now = clock().toISOString();
      const admin = repository.createAdmin({
        username, displayName: String(input.display_name ?? username).slice(0, 80),
        passwordHash: hashPassword(input.password), role: input.role, now,
      });
      repository.audit({
        actorType: 'admin', actorId, action: 'admin.created', subjectType: 'admin', subjectId: admin.id,
        metadata: { username: admin.username, role: admin.role }, now,
      });
      return { id: admin.id, username: admin.username, display_name: admin.display_name, role: admin.role, status: admin.status };
    },

    changeAdminAccountStatus({ id, status, actorId }) {
      invariant(['active', 'suspended'].includes(status), 'ADMIN_STATUS_INVALID', '管理员状态无效');
      invariant(actorId !== id, 'ADMIN_SELF_STATUS', '不能停用自己的账号', 403);
      const now = clock().toISOString();
      const admin = repository.changeAdminStatus(id, status, now);
      invariant(admin, 'ADMIN_PROTECTED', '管理员不存在或受到保护', 403);
      if (status === 'suspended') repository.revokeAdminSessions(admin.id);
      repository.audit({ actorType: 'admin', actorId, action: `admin.${status}`, subjectType: 'admin', subjectId: admin.id, now });
      return { id: admin.id, status: admin.status };
    },

    changeAdminPassword({ id, currentPassword, newPassword, confirmPassword }) {
      const admin = repository.adminById(id);
      invariant(admin && verifyPassword(String(currentPassword ?? ''), admin.password_hash), 'ADMIN_PASSWORD_CURRENT_INVALID', '当前密码不正确', 403);
      invariant(/^\d{6}$/.test(newPassword ?? ''), 'ADMIN_PASSWORD_INVALID', '新密码必须是 6 位数字');
      invariant(newPassword === confirmPassword, 'ADMIN_PASSWORD_CONFIRM_MISMATCH', '两次输入的新密码不一致');
      invariant(newPassword !== currentPassword, 'ADMIN_PASSWORD_UNCHANGED', '新密码不能与当前密码相同');
      const now = clock().toISOString();
      repository.updateAdminPassword(admin.id, hashPassword(newPassword), now);
      repository.audit({ actorType: 'admin', actorId: admin.id, action: 'admin.password_changed', subjectType: 'admin', subjectId: admin.id, now });
      repository.revokeAdminSessions(admin.id);
      return { ok: true, reauth_required: true };
    },

    deleteAdminAccount({ id, actorId }) {
      invariant(actorId !== id, 'ADMIN_SELF_DELETE', '不能删除当前登录账号', 403);
      const target = repository.adminById(id);
      invariant(target && !target.deleted_at, 'ADMIN_NOT_FOUND', '管理员不存在', 404);
      invariant(!target.is_owner && target.role !== 'owner', 'ADMIN_PROTECTED', '平台所有者账号不能删除', 403);
      const now = clock().toISOString();
      const deleted = repository.deleteAdmin(target.id, now);
      invariant(deleted, 'ADMIN_PROTECTED', '管理员不存在或受到保护', 403);
      repository.revokeAdminSessions(target.id);
      repository.audit({
        actorType: 'admin', actorId, action: 'admin.deleted', subjectType: 'admin', subjectId: target.id,
        metadata: { username: target.username, role: target.role }, now,
      });
      return { id: target.id, deleted: true };
    },
  };
}

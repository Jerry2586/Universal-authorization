import { newId } from '../../../../packages/core/src/identifiers.js';

export function createIdentitySqliteRepository(queries) {
  return Object.freeze({
    createSession(values) {
      queries.insertSession.run(
        values.id, values.tokenHash, values.csrfToken, values.actorType, values.actorId ?? null,
        values.expiresAt, values.now, values.now,
      );
      return queries.sessionByHash.get(values.tokenHash);
    },
    sessionByHash: (hash) => queries.sessionByHash.get(hash),
    touchSession: (id, now) => queries.touchSession.run(now, id),
    deleteSession: (id) => queries.deleteSession.run(id),
    deleteExpiredSessions: (now) => queries.deleteExpiredSessions.run(now),
    createAdmin(values) {
      const id = values.id ?? newId('adm');
      queries.insertAdmin.run(
        id, values.username, values.displayName ?? values.username, values.passwordHash,
        values.role ?? 'support', JSON.stringify(values.permissions ?? []), values.isOwner ? 1 : 0,
        values.now, values.now,
      );
      return queries.adminById.get(id);
    },
    adminByUsername: (username) => queries.adminByUsername.get(username),
    adminById: (id) => queries.adminById.get(id),
    listAdmins: () => queries.listAdmins.all(),
    updateAdminLogin(id, ip, now) {
      queries.updateAdminLogin.run(now, ip ?? null, now, id);
      return queries.adminById.get(id);
    },
    changeAdminStatus(id, status, now) {
      const changed = queries.changeAdminStatus.run(status, now, id).changes;
      return changed === 1 ? queries.adminById.get(id) : null;
    },
    updateAdminPassword(id, passwordHash, now) {
      const changed = queries.updateAdminPassword.run(passwordHash, now, id).changes;
      return changed === 1 ? queries.adminById.get(id) : null;
    },
    deleteAdmin(id, now) {
      const changed = queries.softDeleteAdmin.run(now, now, id).changes;
      return changed === 1 ? queries.adminById.get(id) : null;
    },
    revokeAdminSessions(id) { queries.revokeAdminSessions.run(id); },
  });
}

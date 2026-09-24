export function createSessionRepositoryPort(repository) {
  return Object.freeze({
    adminById: repository.adminById,
    adminByUsername: repository.adminByUsername,
    updateAdminLogin: repository.updateAdminLogin,
    licenseByHash: repository.licenseByHash,
    createSession: repository.createSession,
    sessionByHash: repository.sessionByHash,
    touchSession: repository.touchSession,
    deleteSession: repository.deleteSession,
    deleteExpiredSessions: repository.deleteExpiredSessions,
  });
}

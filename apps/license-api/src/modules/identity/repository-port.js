export function createIdentityRepositoryPort(repository) {
  return Object.freeze({
    adminById: repository.adminById,
    adminByUsername: repository.adminByUsername,
    createAdmin: repository.createAdmin,
    changeAdminStatus: repository.changeAdminStatus,
    updateAdminPassword: repository.updateAdminPassword,
    deleteAdmin: repository.deleteAdmin,
    revokeAdminSessions: repository.revokeAdminSessions,
    audit: repository.audit,
  });
}

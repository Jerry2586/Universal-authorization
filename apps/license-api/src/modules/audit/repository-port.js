export function createAuditRepositoryPort(repository) {
  return Object.freeze({
    audit: repository.audit,
    recordLicenseEvent: repository.recordLicenseEvent,
  });
}

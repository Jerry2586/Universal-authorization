export function createAuditRepositoryPort(repository) {
  return Object.freeze({
    audit: repository.audit,
    recordLicenseEvent: repository.recordLicenseEvent,
    listLicenseEvents: repository.listLicenseEvents,
  });
}

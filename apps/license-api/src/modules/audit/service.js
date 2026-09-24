export function createAuditService({ repository }) {
  return Object.freeze({
    record(event) {
      return repository.audit(event);
    },
    recordLicenseEvent(event) {
      return repository.recordLicenseEvent(event);
    },
  });
}

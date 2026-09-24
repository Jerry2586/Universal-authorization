export function createAuditService({ repository }) {
  function sanitizeMetadata(value) {
    if (Array.isArray(value)) return value.map(sanitizeMetadata);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      /(key|secret|token|password|credential)/i.test(key) ? '[REDACTED]' : sanitizeMetadata(item),
    ]));
  }

  return Object.freeze({
    record(event) {
      return repository.audit(event);
    },
    recordLicenseEvent(event) {
      return repository.recordLicenseEvent(event);
    },
    listLicenseEvents(licenseId, limit = 200) {
      return repository.listLicenseEvents(licenseId, limit).map((event) => {
        let metadata = {};
        try { metadata = JSON.parse(event.metadata_json ?? '{}'); } catch { metadata = {}; }
        const { metadata_json: _metadataJson, ...record } = event;
        return { ...record, metadata: sanitizeMetadata(metadata) };
      });
    },
  });
}

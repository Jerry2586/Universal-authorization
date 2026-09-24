import { newId } from '../../../../packages/core/src/identifiers.js';

export function createAuditSqliteRepository(queries) {
  return Object.freeze({
    audit({ actorType, actorId = null, action, subjectType, subjectId = null, metadata = {}, now }) {
      queries.insertAudit.run(newId('evt'), actorType, actorId, action, subjectType, subjectId, JSON.stringify(metadata), now);
    },
    recordLicenseEvent(values) {
      const id = values.id ?? newId('lev');
      queries.insertLicenseEvent.run(
        id, values.licenseId, values.eventType, values.buildId ?? null, values.activationId ?? null,
        values.installationId ?? null, values.result ?? 'success', values.reasonCode ?? null,
        values.actorType ?? 'system', values.actorId ?? null, values.requestIp ?? null,
        values.userAgent ?? null, JSON.stringify(values.metadata ?? {}), values.now,
      );
      return id;
    },
    listLicenseEvents: (licenseId, limit = 200) => queries.listLicenseEvents.all(licenseId, limit),
    listAudit(limit = 100) {
      return queries.listAudit.all(limit).map((event) => ({ ...event, metadata: JSON.parse(event.metadata_json) }));
    },
  });
}

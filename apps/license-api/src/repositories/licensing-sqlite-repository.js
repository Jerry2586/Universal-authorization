import { newId } from '../../../../packages/core/src/identifiers.js';

export function createLicensingSqliteRepository(queries) {
  return Object.freeze({
    createLicense(values) {
      queries.insertLicense.run(
        values.id, values.productId, values.customerRef, values.keyPrefix, values.keyHash, values.keyEncrypted ?? null,
        values.status, values.boundDomain ?? null, values.updateUntil ?? null,
        values.maxBuildsPerDay, values.maxActivations, values.planId ?? null, values.now, values.now,
      );
      return queries.licenseById.get(values.id);
    },
    licenseByHash: (hash) => queries.licenseByHash.get(hash),
    licenseById: (id) => queries.licenseById.get(id),
    bindDomain(id, domain, now) {
      queries.bindDomain.run(domain, now, id);
      return queries.licenseById.get(id);
    },
    rotateLicense(id, prefix, hash, encrypted, now) {
      queries.rotateLicense.run(prefix, hash, encrypted, now, id);
      return queries.licenseById.get(id);
    },
    createDomainMigration(values) {
      const id = values.id ?? newId('dmr');
      queries.insertDomainMigration.run(
        id, values.licenseId, values.previousDomain, values.requestedDomain, values.reason ?? '', values.now,
      );
      return queries.domainMigrationById.get(id);
    },
    domainMigrationById: (id) => queries.domainMigrationById.get(id),
    pendingDomainMigrationByLicense: (licenseId) => queries.pendingDomainMigrationByLicense.get(licenseId),
    latestApprovedDomainMigrationByLicense: (licenseId) => queries.latestApprovedDomainMigrationByLicense.get(licenseId),
    listDomainMigrations: (limit = 100) => queries.listDomainMigrations.all(limit),
    decideDomainMigration(id, status, reviewerId, reviewNote, now) {
      const changed = queries.decideDomainMigration.run(status, now, reviewerId, reviewNote ?? null, id).changes;
      return changed === 1 ? queries.domainMigrationById.get(id) : null;
    },
    listLicenses: (limit = 100) => queries.listLicenses.all(limit),
    changeLicenseDomain(id, domain, now) {
      queries.changeLicenseDomain.run(domain, now, id);
      return queries.licenseById.get(id);
    },
    changeLicenseStatus(id, status, now) {
      queries.changeLicenseStatus.run(status, now, id);
      return queries.licenseById.get(id);
    },
  });
}

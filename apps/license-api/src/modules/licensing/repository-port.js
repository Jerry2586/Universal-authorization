const METHODS = Object.freeze([
  'bindDomain', 'changeLicenseDomain', 'changeLicenseQuota', 'changeLicenseStatus', 'createDomainMigration',
  'createLicense', 'decideDomainMigration', 'domainMigrationById', 'latestApprovedDomainMigrationByLicense',
  'licenseByHash', 'licenseById', 'pendingDomainMigrationByLicense', 'planByCode', 'rotateLicense',
]);

export function createLicensingRepositoryPort(repository) {
  return Object.freeze(Object.fromEntries(METHODS.map((name) => [name, repository[name]])));
}

const METHODS = Object.freeze([
  'beginLicenseErasure', 'deleteLicenseGraph', 'erasureJobByLicense', 'finishLicenseErasure',
  'licenseById', 'listPendingErasureJobs', 'updateErasureJob',
]);

export function createLicenseErasureRepositoryPort(repository) {
  return Object.freeze(Object.fromEntries(METHODS.map((name) => [name, repository[name]])));
}

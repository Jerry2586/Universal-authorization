const METHODS = Object.freeze([
  'beginLicenseErasure', 'completeCleanupTask', 'completeErasureCleanup', 'deleteLicenseGraph',
  'erasureJobByLicense', 'failCleanupTask', 'finishLicenseErasure', 'licenseById',
  'listPendingCleanupTasks', 'listPendingErasureJobs', 'pendingCleanupCount', 'updateErasureJob',
]);

export function createLicenseErasureRepositoryPort(repository) {
  return Object.freeze(Object.fromEntries(METHODS.map((name) => [name, repository[name]])));
}

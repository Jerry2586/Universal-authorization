const METHODS = Object.freeze([
  'activeActivationByLicense', 'latestApprovedDomainMigrationByLicense', 'licenseById',
  'listActiveSourceVersions', 'listBuildJobsByLicense', 'recentBuildCount', 'setting', 'totalBuildCount',
]);

export function createCustomerPortalRepositoryPort(repository) {
  return Object.freeze(Object.fromEntries(METHODS.map((name) => [name, repository[name]])));
}

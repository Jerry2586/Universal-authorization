const METHODS = Object.freeze([
  'buildDeliveryById', 'activeActivationByLicense', 'latestApprovedDomainMigrationByLicense', 'licenseById',
  'listActiveSourceVersions', 'listBuildJobsByLicense', 'recentBuildCount', 'setting', 'totalBuildCount',
]);

export function createCustomerPortalRepositoryPort(repository) {
  return Object.freeze(Object.fromEntries(METHODS.map((name) => [name, repository[name]])));
}

const METHODS = Object.freeze([
  'dashboardStats', 'listActivations', 'listAdmins', 'listAudit', 'listBuildJobs',
  'listDomainMigrations', 'listLicenses', 'listPlans', 'allPlans', 'listSourceVersions', 'recentBuildCount',
]);

export function createAdminOverviewRepositoryPort(repository) {
  return Object.freeze(Object.fromEntries(METHODS.map((name) => [name, repository[name]])));
}

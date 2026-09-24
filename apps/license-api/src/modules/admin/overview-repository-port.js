const METHODS = Object.freeze([
  'dashboardStats', 'listActivations', 'listAdmins', 'listAudit', 'listBuildJobs',
  'listDomainMigrations', 'listLicenses', 'listPlans', 'listSourceVersions',
]);

export function createAdminOverviewRepositoryPort(repository) {
  return Object.freeze(Object.fromEntries(METHODS.map((name) => [name, repository[name]])));
}

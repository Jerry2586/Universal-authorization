const METHODS = Object.freeze([
  'activateInstallReceipt', 'activationById', 'activeActivationByInstallation', 'activeActivationForEnvironment',
  'audit', 'bindDomain', 'buildById', 'changeLicenseDomain', 'changeLicensePlan', 'changeLicenseStatus',
  'claimTicket', 'consumeInstallationChallenge', 'consumeInstallKey', 'consumeProductMigrationGrant', 'consumeTicket',
  'countActiveActivationsForLicense', 'createActivation', 'createBuild', 'createDomainMigration',
  'createInstallationChallenge', 'createInstallKey', 'createInstallReceipt', 'createLicense', 'createProduct',
  'createProductMigrationGrant', 'createTicket', 'decideDomainMigration', 'domainMigrationById',
  'fenceActivationsByInstallation', 'fenceInstallationIdentity', 'installationChallengeById',
  'installationIdentityById', 'installKeyByHash', 'installReceiptById', 'latestApprovedDomainMigrationByLicense',
  'licenseByHash', 'licenseById', 'listActiveSourceVersions', 'markBuildActivated', 'markBuildUnlocked',
  'pendingDomainMigrationByLicense', 'planByCode', 'productByCode', 'productMigrationGrantByHash',
  'recentBuildCount', 'recordLicenseEvent', 'registerInstallationIdentity', 'revokeActivationsByLicense',
  'revokeInstallReceiptsByLicense', 'rotateLicense', 'sourceVersionByProductVersion', 'supersedeActivations',
  'ticketByHash', 'touchInstallationIdentity', 'updateActivationSeen',
]);

export function createLicensingRepositoryPort(repository) {
  return Object.freeze(Object.fromEntries(METHODS.map((name) => [name, repository[name]])));
}

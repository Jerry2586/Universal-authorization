const METHODS = Object.freeze([
  'activateInstallReceipt', 'activationById', 'activeActivationByInstallation',
  'activeActivationForEnvironment', 'buildById', 'consumeInstallationChallenge',
  'consumeInstallKey', 'consumeProductMigrationGrant', 'countActiveActivationsForLicense',
  'createActivation', 'createInstallationChallenge', 'createInstallReceipt',
  'createInstallWindow', 'installWindowByBuildInstallation', 'installWindowById',
  'consumeInstallWindow', 'expireInstallWindow',
  'createProductMigrationGrant', 'fenceActivationsByInstallation', 'fenceInstallationIdentity',
  'installationChallengeById', 'installationIdentityById', 'installKeyByHash',
  'installReceiptById', 'licenseByHash', 'licenseById', 'markBuildActivated',
  'markBuildUnlocked', 'productMigrationGrantByHash', 'registerInstallationIdentity',
  'prepareProductMigrationGrant', 'completeProductMigrationGrant', 'rollbackProductMigrationGrant',
  'transitionActivationStatus', 'activateInstallationIdentity', 'revokeInstallationIdentity',
  'revokeActivationsByLicense', 'revokeInstallReceiptsByLicense', 'supersedeActivations',
  'touchInstallationIdentity', 'updateActivationSeen',
  'recoverActivationCredentials', 'createOfflineLicenseFile',
]);

export function createActivationRepositoryPort(repository) {
  return Object.freeze(Object.fromEntries(METHODS.map((name) => [name, repository[name]])));
}

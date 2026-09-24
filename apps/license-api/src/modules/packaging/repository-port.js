export function createPackagingRepositoryPort(repository) {
  return Object.freeze({
    licenseById: repository.licenseById,
    sourceVersionByProductVersion: repository.sourceVersionByProductVersion,
    listActiveSourceVersions: repository.listActiveSourceVersions,
    activeActivationByLicense: repository.activeActivationByLicense,
    buildJobById: repository.buildJobById,
    assignBuildToJob: repository.assignBuildToJob,
    revokeUnactivatedBuild: repository.revokeUnactivatedBuild,
    sourceVersionById: repository.sourceVersionById,
    buildById: repository.buildById,
    installKeyByBuildId: repository.installKeyByBuildId,
    audit: repository.audit,
  });
}

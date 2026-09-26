export function createPackagingRepositoryPort(repository) {
  return Object.freeze({
    buildDeliveryById: repository.buildDeliveryById,
    reusableBuildJob: repository.reusableBuildJob,
    expiredBuildJobs: repository.expiredBuildJobs,
    failBuildJob: repository.failBuildJob,
    cancelledArtifacts: repository.cancelledArtifacts,
    clearCancelledArtifact: repository.clearCancelledArtifact,
    cancelBuildJob: repository.cancelBuildJob,
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

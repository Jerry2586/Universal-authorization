export function createEntitlementRepositoryPort(repository) {
  return Object.freeze({
    allPlans: repository.allPlans,
    savePlan: repository.savePlan,
    deletePlan: repository.deletePlan,
    licenseById: repository.licenseById,
    planByCode: repository.planByCode,
    changeLicensePlan: repository.changeLicensePlan,
  });
}

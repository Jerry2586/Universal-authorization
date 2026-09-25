export function createEntitlementRepositoryPort(repository) {
  return Object.freeze({
    allPlans: repository.allPlans,
    savePlan: repository.savePlan,
    licenseById: repository.licenseById,
    planByCode: repository.planByCode,
    changeLicensePlan: repository.changeLicensePlan,
  });
}

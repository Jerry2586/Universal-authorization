export function createEntitlementRepositoryPort(repository) {
  return Object.freeze({
    licenseById: repository.licenseById,
    planByCode: repository.planByCode,
    changeLicensePlan: repository.changeLicensePlan,
  });
}

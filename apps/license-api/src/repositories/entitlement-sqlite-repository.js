export function createEntitlementSqliteRepository(queries) {
  return Object.freeze({
    planByCode: (code) => queries.planByCode.get(code),
    listPlans: () => queries.listPlans.all(),
    changeLicensePlan(id, planId, now) {
      queries.changeLicensePlan.run(planId, now, id);
      return queries.licenseById.get(id);
    },
  });
}

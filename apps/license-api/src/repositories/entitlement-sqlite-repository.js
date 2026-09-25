export function createEntitlementSqliteRepository(queries) {
  return Object.freeze({
    planByCode: (code) => queries.planByCode.get(code),
    listPlans: () => queries.listPlans.all(),
    changeLicensePlan(id, planId, snapshot, now) {
      queries.changeLicensePlan.run(
        planId, JSON.stringify(snapshot.capabilities), JSON.stringify(snapshot.limits),
        snapshot.maxBuildsPerDay, snapshot.maxActivations, now, id,
      );
      return queries.licenseById.get(id);
    },
  });
}

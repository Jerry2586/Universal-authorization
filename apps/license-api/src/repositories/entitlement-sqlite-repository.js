export function createEntitlementSqliteRepository(queries) {
  return Object.freeze({
    planByCode: (code) => queries.planByCode.get(code),
    listPlans: () => queries.listPlans.all(),
    allPlans: () => queries.allPlans.all(),
    savePlan(plan, creating) {
      const fields = [plan.name, plan.access_tier, plan.status, JSON.stringify(plan.capabilities), JSON.stringify(plan.limits)];
      if (creating) queries.insertPlan.run(plan.id, plan.code, ...fields, plan.now, plan.now);
      else queries.updatePlan.run(...fields, plan.now, plan.code);
      return queries.planByCode.get(plan.code);
    },
    changeLicensePlan(id, planId, snapshot, now) {
      queries.changeLicensePlan.run(
        planId, JSON.stringify(snapshot.capabilities), JSON.stringify(snapshot.limits),
        snapshot.maxBuildsPerDay, snapshot.maxActivations, now, id,
      );
      return queries.licenseById.get(id);
    },
  });
}

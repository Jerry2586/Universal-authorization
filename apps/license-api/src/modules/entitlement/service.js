import { invariant } from '../../../../../packages/core/src/errors.js';
import { transaction } from '../../database.js';
import { iso, parseJsonObject } from '../shared/service-utils.js';

export function createEntitlementService({ database, repository, activationLifecycle, audit, clock = () => new Date() }) {
  return Object.freeze({
    changeLicensePlan({ licenseId, planCode, actorId = null }) {
      const license = repository.licenseById(licenseId);
      invariant(license, 'LICENSE_NOT_FOUND', '授权不存在', 404);
      invariant(license.status !== 'deleting', 'LICENSE_DELETING', '授权正在永久删除', 409);
      const plan = repository.planByCode(String(planCode ?? '').trim().toLowerCase());
      invariant(plan && plan.status === 'active', 'LICENSE_PLAN_INVALID', '授权套餐不存在或已停用');
      invariant(license.plan_id !== plan.id, 'LICENSE_PLAN_UNCHANGED', '授权套餐没有变化', 409);
      const planCapabilities = parseJsonObject(plan.capabilities_json, []);
      const planLimits = parseJsonObject(plan.limits_json, {});
      const maxBuildsPerDay = Number.isInteger(planLimits.max_builds_per_day)
        ? planLimits.max_builds_per_day : license.max_builds_per_day;
      const maxActivations = Number.isInteger(planLimits.max_activations)
        ? planLimits.max_activations : license.max_activations;
      const snapshot = {
        capabilities: planCapabilities,
        limits: { max_builds_per_day: maxBuildsPerDay, max_activations: maxActivations },
        maxBuildsPerDay,
        maxActivations,
      };
      const now = iso(clock);
      const updated = transaction(database, () => {
        const result = repository.changeLicensePlan(licenseId, plan.id, snapshot, now);
        activationLifecycle.revokeActivationsByLicense(licenseId, now);
        audit.recordLicenseEvent({
          licenseId, eventType: 'license.plan_changed', actorType: 'admin', actorId,
          metadata: { previous_plan: license.plan_code ?? 'legacy', plan_code: plan.code }, now,
        });
        audit.record({
          actorType: 'admin', actorId, action: 'license.plan_changed', subjectType: 'license', subjectId: licenseId,
          metadata: {
            previous_plan: license.plan_code ?? 'legacy', plan_code: plan.code,
            capabilities: planCapabilities, limits: snapshot.limits,
          }, now,
        });
        return result;
      });
      return updated;
    },
  });
}

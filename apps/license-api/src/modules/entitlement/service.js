import { newId } from '../../../../../packages/core/src/identifiers.js';
import { invariant } from '../../../../../packages/core/src/errors.js';
import { transaction } from '../../database.js';
import { iso, parseJsonObject } from '../shared/service-utils.js';

export function createEntitlementService({ database, repository, activationLifecycle, audit, clock = () => new Date() }) {
  function versionEligibility({ license, source }) {
    const accessTier = source?.access_tier === 'paid' ? 'paid' : 'free';
    const planCode = license?.plan_code ?? 'legacy';
    const tier = parseJsonObject(license?.plan_limits_json ?? license?.entitlement_limits_json, {}).access_tier
      ?? (['paid', 'legacy'].includes(planCode) ? 'paid' : 'free');
    if (accessTier === 'paid' && tier !== 'paid') {
      return Object.freeze({
        eligible: false,
        code: 'VERSION_PLAN_REQUIRED',
        reason: '该版本仅限付费授权使用',
        accessTier,
        planCode,
      });
    }
    return Object.freeze({ eligible: true, code: null, reason: null, accessTier, planCode });
  }

  function assertVersionAccess({ license, source }) {
    const result = versionEligibility({ license, source });
    invariant(result.eligible, result.code, result.reason, 403);
    return result;
  }

  function publicPlan(plan) {
    return { id: plan.id, code: plan.code, name: plan.name, access_tier: plan.access_tier,
      status: plan.status, capabilities: parseJsonObject(plan.capabilities_json, []),
      limits: parseJsonObject(plan.limits_json, {}), updated_at: plan.updated_at };
  }
  const capabilities = ['settings:read', 'settings:write', 'protected:read', 'theme:enable', 'xboard:connect', 'updates:read'];
  function savePlan({ code, name, accessTier, status = 'active', capabilities: selected, limits, actorId }, creating) {
    code = String(code ?? '').trim().toLowerCase();
    name = String(name ?? '').trim();
    invariant(/^[a-z][a-z0-9_-]{1,39}$/.test(code), 'PLAN_CODE_INVALID', '套餐标识须为 2–40 位小写字母、数字、下划线或短横线');
    invariant(name.length >= 1 && name.length <= 60, 'PLAN_NAME_INVALID', '套餐名称须为 1–60 个字符');
    invariant(['free', 'paid'].includes(accessTier), 'PLAN_TIER_INVALID', '请选择免费或付费权益');
    invariant(['active', 'disabled'].includes(status), 'PLAN_STATUS_INVALID', '套餐状态无效');
    invariant(Array.isArray(selected) && selected.length <= capabilities.length && selected.every(c => capabilities.includes(c)), 'PLAN_CAPABILITIES_INVALID', '套餐能力无效');
    invariant(Number.isInteger(limits?.max_builds_per_day) && limits.max_builds_per_day >= 1 && limits.max_builds_per_day <= 50, 'PLAN_LIMIT_INVALID', '每日打包上限须为 1–50');
    invariant(Number.isInteger(limits?.max_activations) && limits.max_activations >= 1 && limits.max_activations <= 20, 'PLAN_LIMIT_INVALID', '激活环境上限须为 1–20');
    const now = iso(clock);
    return transaction(database, () => {
      const existing = repository.planByCode(code);
      invariant(creating ? !existing : Boolean(existing), creating ? 'PLAN_EXISTS' : 'PLAN_NOT_FOUND', creating ? '套餐标识已存在' : '套餐不存在', creating ? 409 : 404);
      invariant(code !== 'legacy', 'PLAN_RESERVED', '历史兼容套餐由系统维护', 409);
      const result = repository.savePlan({ id: existing?.id ?? newId('plan'), code, name, access_tier: accessTier, status,
        capabilities: [...new Set(selected)], limits: { max_builds_per_day: limits.max_builds_per_day, max_activations: limits.max_activations }, now }, creating);
      audit.record({ actorType: 'admin', actorId, action: creating ? 'plan.created' : 'plan.updated', subjectType: 'plan', subjectId: result.id,
        metadata: { before: existing ? publicPlan(existing) : null, after: publicPlan(result) }, now });
      return publicPlan(result);
    });
  }

  return Object.freeze({
    listLicensePlans: () => repository.allPlans().map(publicPlan),
    createLicensePlan: input => savePlan(input, true),
    updateLicensePlan: input => savePlan(input, false),
    versionEligibility,
    assertVersionAccess,
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
        limits: { access_tier: plan.access_tier, max_builds_per_day: maxBuildsPerDay, max_activations: maxActivations },
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

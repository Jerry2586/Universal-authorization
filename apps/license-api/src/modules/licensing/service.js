import { createHash } from 'node:crypto';
import { canonicalizeDomain } from '../../../../../packages/core/src/canonicalize.js';
import { invariant } from '../../../../../packages/core/src/errors.js';
import { keyPrefix, newId, newLicenseKey } from '../../../../../packages/core/src/identifiers.js';
import { hashSecret } from '../../../../../packages/core/src/security.js';
import { openSecret, sealSecret } from '../../../../../packages/core/src/secret-box.js';
import { LICENSE_STATUS } from '../../../../../packages/core/src/states.js';
import { transaction } from '../../database.js';
import { iso, parseJsonObject } from '../shared/service-utils.js';

export function createLicensingService({
  database, repository, productCatalog, activationLifecycle, audit, config, clock = () => new Date(),
}) {
  const configuredKey = config.licenseEncryptionKey ?? config.deliveryEncryptionKey ?? config.pepper ?? 'development-license-key';
  const licenseEncryptionKey = configuredKey.length >= 32
    ? configuredKey
    : createHash('sha256').update(`appgog-license-key:${configuredKey}`).digest('hex');

  function findActiveLicense(rawKey) {
    const license = repository.licenseByHash(hashSecret(rawKey, config.pepper));
    invariant(license, 'LICENSE_NOT_FOUND', '授权 Key 无效', 404);
    invariant(license.status === LICENSE_STATUS.ACTIVE, 'LICENSE_INACTIVE', '授权已暂停或撤销', 403);
    return license;
  }

  function bindDomainForBuild(license, normalizedDomain, now) {
    const resolved = license.bound_domain ? license : repository.bindDomain(license.id, normalizedDomain, now);
    invariant(resolved.bound_domain === normalizedDomain, 'LICENSE_DOMAIN_MISMATCH', '固定 Key 已绑定其他域名', 403);
    return resolved;
  }

  return Object.freeze({
    internal: Object.freeze({ findActiveLicense, bindDomainForBuild }),
    issueLicense({
      productCode = 'appgog', customerRef, domain = null, updateUntil = null, planCode = 'legacy',
      maxBuildsPerDay = null, maxActivations = null, actorId = null,
    }) {
      const product = productCatalog.ensureProduct({ code: productCode, name: productCode.toUpperCase() });
      const plan = repository.planByCode(String(planCode ?? 'legacy').trim().toLowerCase());
      invariant(plan && plan.status === 'active', 'LICENSE_PLAN_INVALID', '授权套餐不存在或已停用');
      const planLimits = parseJsonObject(plan.limits_json, {});
      const planCapabilities = parseJsonObject(plan.capabilities_json, []);
      const resolvedBuildLimit = maxBuildsPerDay ?? planLimits.max_builds_per_day ?? 3;
      const resolvedActivationLimit = maxActivations ?? planLimits.max_activations ?? 1;
      invariant(customerRef?.trim(), 'CUSTOMER_REQUIRED', '必须提供客户编号');
      invariant(Number.isInteger(resolvedBuildLimit) && resolvedBuildLimit >= 1 && resolvedBuildLimit <= 50,
        'BUILD_LIMIT_INVALID', '每日打包上限必须为 1 到 50 的整数');
      invariant(Number.isInteger(resolvedActivationLimit) && resolvedActivationLimit >= 1 && resolvedActivationLimit <= 20,
        'ACTIVATION_LIMIT_INVALID', '激活数量上限必须为 1 到 20 的整数');
      if (Number.isInteger(planLimits.max_builds_per_day)) {
        invariant(resolvedBuildLimit <= planLimits.max_builds_per_day, 'BUILD_LIMIT_EXCEEDS_PLAN',
          `该套餐每日最多构建 ${planLimits.max_builds_per_day} 次`);
      }
      if (Number.isInteger(planLimits.max_activations)) {
        invariant(resolvedActivationLimit <= planLimits.max_activations, 'ACTIVATION_LIMIT_EXCEEDS_PLAN',
          `该套餐最多激活 ${planLimits.max_activations} 个环境`);
      }
      if (updateUntil) invariant(!Number.isNaN(new Date(updateUntil).getTime()), 'UPDATE_DATE_INVALID', '更新到期时间无效');
      const plainKey = newLicenseKey(product.code);
      const now = iso(clock);
      const license = transaction(database, () => {
        const created = repository.createLicense({
          id: newId('lic'), productId: product.id, customerRef: customerRef.trim(), keyPrefix: keyPrefix(plainKey),
          keyHash: hashSecret(plainKey, config.pepper), keyEncrypted: sealSecret(plainKey, licenseEncryptionKey),
          status: LICENSE_STATUS.ACTIVE, boundDomain: domain ? canonicalizeDomain(domain) : null,
          updateUntil, maxBuildsPerDay: resolvedBuildLimit, maxActivations: resolvedActivationLimit,
          planId: plan.id, entitlementCapabilities: planCapabilities,
          entitlementLimits: {
            max_builds_per_day: resolvedBuildLimit,
            max_activations: resolvedActivationLimit,
          }, now,
        });
        audit.recordLicenseEvent({
          licenseId: created.id, eventType: 'license.issued', actorType: 'admin', actorId,
          metadata: { plan_code: plan.code }, now,
        });
        audit.record({
          actorType: 'admin', actorId, action: 'license.issued', subjectType: 'license', subjectId: created.id,
          metadata: { plan_code: plan.code }, now,
        });
        return created;
      });
      return { license, licenseKey: plainKey };
    },

    bindLicenseDomain({ licenseId, domain, actorId = licenseId }) {
      const normalized = canonicalizeDomain(domain);
      const now = iso(clock);
      return transaction(database, () => {
        const current = repository.licenseById(licenseId);
        invariant(current, 'LICENSE_NOT_FOUND', '授权不存在', 404);
        invariant(current.status === LICENSE_STATUS.ACTIVE, 'LICENSE_INACTIVE', '授权已暂停或撤销', 403);
        invariant(!current.bound_domain, 'DOMAIN_ALREADY_BOUND', '授权域名已经绑定，换域名必须提交迁移申请', 409);
        const license = repository.bindDomain(licenseId, normalized, now);
        invariant(license.bound_domain === normalized, 'DOMAIN_BIND_RACE', '授权域名正在被另一个请求绑定', 409);
        audit.recordLicenseEvent({
          licenseId, eventType: 'license.domain_bound', actorType: 'customer', actorId,
          metadata: { domain: normalized }, now,
        });
        audit.record({
          actorType: 'customer', actorId, action: 'license.domain_bound', subjectType: 'license', subjectId: licenseId,
          metadata: { domain: normalized }, now,
        });
        return license;
      });
    },

    requestDomainMigration({ licenseId, domain, reason = '', actorId = licenseId }) {
      const normalized = canonicalizeDomain(domain);
      const note = String(reason ?? '').trim();
      invariant(note.length >= 8 && note.length <= 500, 'DOMAIN_MIGRATION_REASON_INVALID', '域名迁移原因必须为 8–500 个字符');
      const now = iso(clock);
      return transaction(database, () => {
        const license = repository.licenseById(licenseId);
        invariant(license, 'LICENSE_NOT_FOUND', '授权不存在', 404);
        invariant(license.status === LICENSE_STATUS.ACTIVE, 'LICENSE_INACTIVE', '授权已暂停或撤销', 403);
        invariant(license.bound_domain, 'DOMAIN_NOT_BOUND', '请先完成首次域名绑定', 409);
        invariant(license.bound_domain !== normalized, 'DOMAIN_UNCHANGED', '新域名与当前绑定域名相同', 409);
        invariant(!repository.pendingDomainMigrationByLicense(licenseId), 'DOMAIN_MIGRATION_PENDING', '已有待审核的域名迁移申请', 409);
        const request = repository.createDomainMigration({
          licenseId, previousDomain: license.bound_domain, requestedDomain: normalized, reason: note, now,
        });
        audit.recordLicenseEvent({
          licenseId, eventType: 'license.domain_migration_requested', actorType: 'customer', actorId,
          metadata: { request_id: request.id, previous_domain: license.bound_domain, requested_domain: normalized }, now,
        });
        audit.record({
          actorType: 'customer', actorId, action: 'license.domain_migration_requested',
          subjectType: 'domain_migration', subjectId: request.id,
          metadata: { previous_domain: license.bound_domain, requested_domain: normalized }, now,
        });
        return request;
      });
    },

    reviewDomainMigration({ requestId, decision, reviewerId, reviewNote = '' }) {
      invariant(['approved', 'rejected'].includes(decision), 'DOMAIN_MIGRATION_DECISION_INVALID', '域名迁移审批结果无效');
      const now = iso(clock);
      return transaction(database, () => {
        const request = repository.domainMigrationById(requestId);
        invariant(request, 'DOMAIN_MIGRATION_NOT_FOUND', '域名迁移申请不存在', 404);
        invariant(request.status === 'pending', 'DOMAIN_MIGRATION_REVIEWED', '域名迁移申请已经处理', 409);
        invariant(request.license_status === LICENSE_STATUS.ACTIVE, 'LICENSE_INACTIVE', '授权已暂停或撤销', 403);
        invariant(request.bound_domain === request.previous_domain, 'DOMAIN_MIGRATION_STALE', '授权域名已变化，请重新提交迁移申请', 409);
        if (decision === 'approved') {
          repository.changeLicenseDomain(request.license_id, request.requested_domain, now);
          activationLifecycle.revokeInstallReceiptsByLicense(request.license_id, now);
          activationLifecycle.revokeActivationsByLicense(request.license_id, now);
        }
        const reviewed = repository.decideDomainMigration(
          requestId, decision, reviewerId, String(reviewNote ?? '').trim().slice(0, 500), now,
        );
        invariant(reviewed, 'DOMAIN_MIGRATION_RACE', '域名迁移申请正在被另一个管理员处理', 409);
        audit.recordLicenseEvent({
          licenseId: request.license_id, eventType: `license.domain_migration_${decision}`,
          actorType: 'admin', actorId: reviewerId,
          metadata: { request_id: requestId, previous_domain: request.previous_domain, requested_domain: request.requested_domain }, now,
        });
        audit.record({
          actorType: 'admin', actorId: reviewerId, action: `license.domain_migration_${decision}`,
          subjectType: 'domain_migration', subjectId: requestId,
          metadata: { previous_domain: request.previous_domain, requested_domain: request.requested_domain }, now,
        });
        return { request: reviewed, license: repository.licenseById(request.license_id) };
      });
    },

    selfServiceDomainMigration({ licenseId, domain, reason = '', cooldownHours = 0, actorId = licenseId }) {
      const normalized = canonicalizeDomain(domain);
      const note = String(reason ?? '').trim().slice(0, 500);
      const hours = Math.max(0, Number(cooldownHours) || 0);
      const nowDate = clock();
      const now = nowDate.toISOString();
      return transaction(database, () => {
        const license = repository.licenseById(licenseId);
        invariant(license, 'LICENSE_NOT_FOUND', '授权不存在', 404);
        invariant(license.status === LICENSE_STATUS.ACTIVE, 'LICENSE_INACTIVE', '授权已暂停或撤销', 403);
        invariant(license.bound_domain, 'DOMAIN_NOT_BOUND', '请先完成首次域名绑定', 409);
        invariant(license.bound_domain !== normalized, 'DOMAIN_UNCHANGED', '新域名与当前绑定域名相同', 409);
        const latest = repository.latestApprovedDomainMigrationByLicense(licenseId);
        if (hours > 0 && latest?.reviewed_at) {
          const nextAllowed = new Date(new Date(latest.reviewed_at).getTime() + hours * 60 * 60 * 1000);
          invariant(nowDate >= nextAllowed, 'DOMAIN_MIGRATION_COOLDOWN',
            `域名换绑冷却中，下次可操作时间：${nextAllowed.toISOString()}`, 429,
            { next_allowed_at: nextAllowed.toISOString() });
        }
        const request = repository.createDomainMigration({
          licenseId, previousDomain: license.bound_domain, requestedDomain: normalized, reason: note, now,
        });
        const updated = repository.changeLicenseDomain(licenseId, normalized, now);
        activationLifecycle.revokeInstallReceiptsByLicense(licenseId, now);
        activationLifecycle.revokeActivationsByLicense(licenseId, now);
        const reviewed = repository.decideDomainMigration(request.id, 'approved', null, 'customer-self-service', now);
        invariant(reviewed, 'DOMAIN_MIGRATION_RACE', '域名换绑正在被另一个请求处理', 409);
        audit.recordLicenseEvent({
          licenseId, eventType: 'license.domain_migration_self_service', actorType: 'customer', actorId,
          metadata: { request_id: request.id, previous_domain: license.bound_domain, requested_domain: normalized, generation: updated.generation }, now,
        });
        audit.record({
          actorType: 'customer', actorId, action: 'license.domain_migration_self_service',
          subjectType: 'domain_migration', subjectId: request.id,
          metadata: { previous_domain: license.bound_domain, requested_domain: normalized, generation: updated.generation }, now,
        });
        return { request: reviewed, license: updated };
      });
    },

    rotateLicenseKey({ licenseId, actorId = null }) {
      const license = repository.licenseById(licenseId);
      invariant(license, 'LICENSE_NOT_FOUND', '授权不存在', 404);
      const plainKey = newLicenseKey(license.product_code);
      const now = iso(clock);
      const updated = transaction(database, () => {
        const result = repository.rotateLicense(
          licenseId, keyPrefix(plainKey), hashSecret(plainKey, config.pepper),
          sealSecret(plainKey, licenseEncryptionKey), now,
        );
        activationLifecycle.revokeInstallReceiptsByLicense(licenseId, now);
        audit.recordLicenseEvent({ licenseId, eventType: 'license.key_rotated', actorType: 'admin', actorId, now });
        return result;
      });
      audit.record({ actorType: 'admin', actorId, action: 'license.key_rotated', subjectType: 'license', subjectId: licenseId, now });
      return { license: updated, licenseKey: plainKey };
    },

    revealLicenseKey({ licenseId, actorId = null }) {
      const license = repository.licenseById(licenseId);
      invariant(license, 'LICENSE_NOT_FOUND', '授权不存在', 404);
      invariant(license.key_encrypted, 'LICENSE_KEY_LEGACY', '历史 Key 无法恢复，请先轮换 Key 后再查看', 409);
      const now = iso(clock);
      const licenseKey = openSecret(license.key_encrypted, licenseEncryptionKey);
      audit.recordLicenseEvent({ licenseId, eventType: 'license.key_viewed', actorType: 'admin', actorId, now });
      audit.record({ actorType: 'admin', actorId, action: 'license.key_viewed', subjectType: 'license', subjectId: licenseId, now });
      return { license, licenseKey };
    },

    changeLicenseDomain({ licenseId, domain, actorId = null }) {
      const license = repository.licenseById(licenseId);
      invariant(license, 'LICENSE_NOT_FOUND', '授权不存在', 404);
      const normalized = canonicalizeDomain(domain);
      invariant(license.bound_domain !== normalized, 'DOMAIN_UNCHANGED', '新域名与当前绑定域名相同', 409);
      const now = iso(clock);
      const updated = transaction(database, () => {
        const result = repository.changeLicenseDomain(licenseId, normalized, now);
        activationLifecycle.revokeInstallReceiptsByLicense(licenseId, now);
        activationLifecycle.revokeActivationsByLicense(licenseId, now);
        audit.recordLicenseEvent({
          licenseId, eventType: 'license.domain_changed', actorType: 'admin', actorId,
          metadata: { previous_domain: license.bound_domain, domain: normalized }, now,
        });
        return result;
      });
      audit.record({
        actorType: 'admin', actorId, action: 'license.domain_changed', subjectType: 'license', subjectId: licenseId,
        metadata: { previous_domain: license.bound_domain, domain: normalized }, now,
      });
      return updated;
    },

    changeLicenseStatus({ licenseId, status, actorId = null }) {
      invariant(['active', 'suspended', 'revoked'].includes(status), 'LICENSE_STATUS_INVALID', '授权状态无效');
      const license = repository.licenseById(licenseId);
      invariant(license, 'LICENSE_NOT_FOUND', '授权不存在', 404);
      invariant(license.status !== 'revoked' || status === 'revoked', 'LICENSE_REVOKED_FINAL', '已撤销授权不能恢复', 409);
      const now = iso(clock);
      const updated = transaction(database, () => {
        const result = repository.changeLicenseStatus(licenseId, status, now);
        if (status === 'revoked') activationLifecycle.revokeInstallReceiptsByLicense(licenseId, now);
        audit.recordLicenseEvent({
          licenseId, eventType: `license.${status}`, actorType: 'admin', actorId,
          metadata: { previous_status: license.status }, now,
        });
        return result;
      });
      audit.record({
        actorType: 'admin', actorId, action: `license.${status}`, subjectType: 'license', subjectId: licenseId,
        metadata: { previous_status: license.status }, now,
      });
      return updated;
    },
  });
}

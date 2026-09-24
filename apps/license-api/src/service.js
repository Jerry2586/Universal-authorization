import { createHash } from 'node:crypto';
import { canonicalizeBackendOrigin, canonicalizeDomain } from '../../../packages/core/src/canonicalize.js';
import { invariant } from '../../../packages/core/src/errors.js';
import {
  keyPrefix, newBuildTicket, newId, newInstallKey, newInstallReceiptSecret, newInstallationChallengeNonce,
  newLicenseKey, newPackageSecret, newProductMigrationGrant, newRefreshSecret,
} from '../../../packages/core/src/identifiers.js';
import {
  installationContextHash, installationFingerprint, installationIdFromPublicKey, verifyInstallationProof,
} from '../../../packages/core/src/installation-proof.js';
import { hashSecret, secretMatches } from '../../../packages/core/src/security.js';
import { openSecret, sealSecret } from '../../../packages/core/src/secret-box.js';
import { signCompactToken } from '../../../packages/core/src/signing.js';
import { LICENSE_STATUS } from '../../../packages/core/src/states.js';
import { transaction } from './database.js';

function iso(clock) {
  return clock().toISOString();
}

function addSeconds(date, seconds) {
  return new Date(date.getTime() + seconds * 1000).toISOString();
}

function startOfRollingDay(date) {
  return new Date(date.getTime() - 24 * 60 * 60 * 1000).toISOString();
}

export function createLicenseService({
  database, repository, config, privateKey,
  activationPrivateKey = privateKey, packagePrivateKey = privateKey, notificationPrivateKey = privateKey,
  clock = () => new Date(),
}) {
  const configuredLicenseEncryptionKey = config.licenseEncryptionKey ?? config.deliveryEncryptionKey ?? config.pepper ?? 'development-license-key';
  const licenseEncryptionKey = configuredLicenseEncryptionKey.length >= 32
    ? configuredLicenseEncryptionKey
    : createHash('sha256').update(`appgog-license-key:${configuredLicenseEncryptionKey}`).digest('hex');
  function findActiveLicense(rawKey) {
    const license = repository.licenseByHash(hashSecret(rawKey, config.pepper));
    invariant(license, 'LICENSE_NOT_FOUND', '授权 Key 无效', 404);
    invariant(license.status === LICENSE_STATUS.ACTIVE, 'LICENSE_INACTIVE', '授权已暂停或撤销', 403);
    return license;
  }

  function parseJsonObject(value, fallback) {
    try {
      const parsed = JSON.parse(value ?? 'null');
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  function capabilitiesFor(record) {
    const capabilities = parseJsonObject(record.plan_capabilities_json, []);
    return Array.isArray(capabilities) && capabilities.length > 0
      ? capabilities
      : ['settings:read', 'settings:write', 'theme:enable', 'xboard:connect', 'protected:read', 'updates:read'];
  }

  function consumeInstallationProof({ purpose, context, installationId, publicKey, challengeId, signature, now }) {
    const supplied = [publicKey, challengeId, signature].some(Boolean);
    if (!supplied) return null;
    invariant(publicKey && challengeId && signature, 'INSTALLATION_PROOF_REQUIRED', '服务器安装身份证明参数不完整', 401);
    const challenge = repository.installationChallengeById(challengeId);
    invariant(challenge, 'INSTALLATION_CHALLENGE_NOT_FOUND', '安装身份挑战不存在', 404);
    invariant(challenge.status === 'created', 'INSTALLATION_CHALLENGE_USED', '安装身份挑战已经使用', 409);
    invariant(challenge.purpose === purpose, 'INSTALLATION_CHALLENGE_PURPOSE_MISMATCH', '安装身份挑战用途不匹配', 403);
    invariant(challenge.expires_at >= now, 'INSTALLATION_CHALLENGE_EXPIRED', '安装身份挑战已过期', 401);
    invariant(challenge.context_hash === installationContextHash(context), 'INSTALLATION_CHALLENGE_CONTEXT_MISMATCH', '安装身份挑战与当前操作不匹配', 403);
    invariant(challenge.installation_id === installationId, 'INSTALLATION_IDENTITY_MISMATCH', 'Installation ID 与挑战不匹配', 403);
    const identity = verifyInstallationProof({ challenge, publicKey, signature });
    invariant(repository.consumeInstallationChallenge(challenge.id, now), 'INSTALLATION_CHALLENGE_RACE', '安装身份挑战正在被另一个请求使用', 409);
    return { ...identity, publicKey };
  }

  function activationPayload(activation, nowDate) {
    return {
      iss: config.publicBaseUrl,
      sub: activation.id,
      typ: 'activation',
      product: activation.product_code,
      license_id: activation.license_id,
      license_generation: activation.license_generation,
      build_id: activation.build_id,
      package_id: activation.package_id,
      version: activation.version,
      domain: activation.domain,
      backend_origin: activation.backend_origin,
      installation_id: activation.installation_id,
      installation_identity_mode: activation.identity_mode ?? 'legacy',
      installation_public_key_fingerprint: activation.installation_public_key_fingerprint ?? null,
      iat: Math.floor(nowDate.getTime() / 1000),
      exp: Math.floor(nowDate.getTime() / 1000) + config.activationTokenTtlSeconds,
      offline_until: Math.floor(nowDate.getTime() / 1000) + config.activationTokenTtlSeconds + (config.offlineGraceSeconds ?? 2592000),
      plan: activation.plan_code ?? 'legacy',
      capabilities: capabilitiesFor(activation),
    };
  }

  function packageManifestPayload({ buildId, packageId, product, version, domain, watermark }, nowDate) {
    return {
      iss: config.publicBaseUrl,
      typ: 'package-manifest',
      product,
      build_id: buildId,
      package_id: packageId,
      version,
      domain,
      watermark,
      iat: Math.floor(nowDate.getTime() / 1000),
    };
  }

  return {
    ensureProduct({ code = 'appgog', name = 'APPGOG' } = {}) {
      const normalized = code.trim().toLowerCase();
      return repository.productByCode(normalized) ?? repository.createProduct({ code: normalized, name, now: iso(clock) });
    },

    releaseAnnouncement(productCode = 'appgog') {
      const latest = repository.listActiveSourceVersions(productCode)[0] ?? null;
      if (!latest) return { latest: null, release_token: null, build_center_url: config.buildCenterPublicUrl ?? null };
      const release = {
        version: latest.version, display_name: latest.display_name, release_notes: latest.release_notes,
        published_at: latest.published_at ?? latest.created_at, channel: latest.channel, release_kind: latest.release_kind,
      };
      const now = clock();
      return {
        latest: release,
        build_center_url: config.buildCenterPublicUrl ?? null,
        release_token: signCompactToken({ iss: config.publicBaseUrl, typ: 'release', product: productCode,
          ...release, build_center_url: config.buildCenterPublicUrl ?? null,
          iat: Math.floor(now.getTime() / 1000), exp: Math.floor(now.getTime() / 1000) + 86400 }, notificationPrivateKey),
      };
    },

    createInstallationChallenge({ purpose, publicKey, context = {} }) {
      invariant(['activation', 'refresh', 'migration_issue', 'migration_accept'].includes(purpose), 'INSTALLATION_CHALLENGE_PURPOSE_INVALID', '安装身份挑战用途无效');
      invariant(publicKey && typeof publicKey === 'string' && publicKey.length <= 8192, 'INSTALLATION_PUBLIC_KEY_INVALID', '安装身份公钥无效');
      let installationId;
      let fingerprint;
      try {
        installationId = installationIdFromPublicKey(publicKey);
        fingerprint = installationFingerprint(publicKey);
      } catch {
        invariant(false, 'INSTALLATION_PUBLIC_KEY_INVALID', '安装身份公钥无法解析');
      }
      const nowDate = clock();
      const challenge = repository.createInstallationChallenge({
        id: newId('chl'), purpose, installationId, publicKeyFingerprint: fingerprint,
        contextHash: installationContextHash(context), nonce: newInstallationChallengeNonce(),
        expiresAt: addSeconds(nowDate, 300), now: nowDate.toISOString(),
      });
      return {
        id: challenge.id, nonce: challenge.nonce, purpose: challenge.purpose,
        context_hash: challenge.context_hash, installation_id: challenge.installation_id,
        expires_at: challenge.expires_at,
      };
    },

    issueLicense({ productCode = 'appgog', customerRef, domain = null, updateUntil = null, planCode = 'legacy', maxBuildsPerDay = null, maxActivations = null, actorId = null }) {
      const product = this.ensureProduct({ code: productCode, name: productCode.toUpperCase() });
      const plan = repository.planByCode(String(planCode ?? 'legacy').trim().toLowerCase());
      invariant(plan && plan.status === 'active', 'LICENSE_PLAN_INVALID', '授权套餐不存在或已停用');
      const planLimits = parseJsonObject(plan.limits_json, {});
      const resolvedBuildLimit = maxBuildsPerDay ?? planLimits.max_builds_per_day ?? 3;
      const resolvedActivationLimit = maxActivations ?? planLimits.max_activations ?? 1;
      invariant(customerRef?.trim(), 'CUSTOMER_REQUIRED', '必须提供客户编号');
      invariant(Number.isInteger(resolvedBuildLimit) && resolvedBuildLimit >= 1 && resolvedBuildLimit <= 50, 'BUILD_LIMIT_INVALID', '每日打包上限必须为 1 到 50 的整数');
      invariant(Number.isInteger(resolvedActivationLimit) && resolvedActivationLimit >= 1 && resolvedActivationLimit <= 20, 'ACTIVATION_LIMIT_INVALID', '激活数量上限必须为 1 到 20 的整数');
      if (Number.isInteger(planLimits.max_builds_per_day)) {
        invariant(resolvedBuildLimit <= planLimits.max_builds_per_day, 'BUILD_LIMIT_EXCEEDS_PLAN', `该套餐每日最多构建 ${planLimits.max_builds_per_day} 次`);
      }
      if (Number.isInteger(planLimits.max_activations)) {
        invariant(resolvedActivationLimit <= planLimits.max_activations, 'ACTIVATION_LIMIT_EXCEEDS_PLAN', `该套餐最多激活 ${planLimits.max_activations} 个环境`);
      }
      if (updateUntil) invariant(!Number.isNaN(new Date(updateUntil).getTime()), 'UPDATE_DATE_INVALID', '更新到期时间无效');
      const plainKey = newLicenseKey(product.code);
      const now = iso(clock);
      const license = transaction(database, () => {
        const created = repository.createLicense({
          id: newId('lic'),
          productId: product.id,
          customerRef: customerRef.trim(),
          keyPrefix: keyPrefix(plainKey),
          keyHash: hashSecret(plainKey, config.pepper),
          keyEncrypted: sealSecret(plainKey, licenseEncryptionKey),
          status: LICENSE_STATUS.ACTIVE,
          boundDomain: domain ? canonicalizeDomain(domain) : null,
          updateUntil,
          maxBuildsPerDay: resolvedBuildLimit,
          maxActivations: resolvedActivationLimit,
          planId: plan.id,
          now,
        });
        repository.recordLicenseEvent({
          licenseId: created.id, eventType: 'license.issued', actorType: 'admin', actorId,
          metadata: { plan_code: plan.code }, now,
        });
        repository.audit({ actorType: 'admin', actorId, action: 'license.issued', subjectType: 'license', subjectId: created.id,
          metadata: { plan_code: plan.code }, now });
        return created;
      });
      return { license, licenseKey: plainKey };
    },

    authorizeBuild({ licenseKey, version, domain }) {
      invariant(version?.trim(), 'VERSION_REQUIRED', '必须提供主题版本');
      const normalizedDomain = canonicalizeDomain(domain);
      const nowDate = clock();
      const now = nowDate.toISOString();
      return transaction(database, () => {
        let license = findActiveLicense(licenseKey);
        const source = repository.sourceVersionByProductVersion(license.product_code, version.trim());
        if (source) {
          invariant(source.status === 'active', 'SOURCE_VERSION_NOT_READY', '该主题版本不可构建', 409);
          if (license.update_until) invariant(new Date(source.published_at ?? source.created_at) <= new Date(license.update_until), 'UPDATE_WINDOW_EXPIRED', '该版本发布时间已超出更新服务期限', 403);
        } else if (license.update_until) invariant(new Date(license.update_until) >= nowDate, 'UPDATE_WINDOW_EXPIRED', '该授权的更新服务已到期', 403);
        if (!license.bound_domain) license = repository.bindDomain(license.id, normalizedDomain, now);
        invariant(license.bound_domain === normalizedDomain, 'LICENSE_DOMAIN_MISMATCH', '固定 Key 已绑定其他域名', 403);
        const recent = repository.recentBuildCount(license.id, startOfRollingDay(nowDate));
        invariant(recent < license.max_builds_per_day, 'BUILD_RATE_LIMITED', '过去 24 小时打包次数已达到上限', 429);
        const ticket = newBuildTicket();
        const ticketId = newId('btk');
        const expiresAt = addSeconds(nowDate, config.buildTicketTtlSeconds);
        repository.createTicket({
          id: ticketId,
          licenseId: license.id,
          tokenHash: hashSecret(ticket, config.pepper),
          version: version.trim(),
          domain: normalizedDomain,
          expiresAt,
          now,
        });
        repository.audit({
          actorType: 'customer', actorId: license.id, action: 'build.authorized',
          subjectType: 'build_ticket', subjectId: ticketId,
          metadata: { version: version.trim(), domain: normalizedDomain }, now,
        });
        repository.recordLicenseEvent({
          licenseId: license.id, eventType: 'build.authorized', actorType: 'customer', actorId: license.id,
          metadata: { ticket_id: ticketId, version: version.trim() }, now,
        });
        return { buildTicket: ticket, ticketId, expiresAt, product: license.product_code };
      });
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
        repository.audit({
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
        repository.audit({
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
          repository.revokeInstallReceiptsByLicense(request.license_id, now);
          repository.revokeActivationsByLicense(request.license_id, now);
        }
        const reviewed = repository.decideDomainMigration(requestId, decision, reviewerId, String(reviewNote ?? '').trim().slice(0, 500), now);
        invariant(reviewed, 'DOMAIN_MIGRATION_RACE', '域名迁移申请正在被另一个管理员处理', 409);
        repository.audit({
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
      const now = iso(() => nowDate);
      return transaction(database, () => {
        const license = repository.licenseById(licenseId);
        invariant(license, 'LICENSE_NOT_FOUND', '授权不存在', 404);
        invariant(license.status === LICENSE_STATUS.ACTIVE, 'LICENSE_INACTIVE', '授权已暂停或撤销', 403);
        invariant(license.bound_domain, 'DOMAIN_NOT_BOUND', '请先完成首次域名绑定', 409);
        invariant(license.bound_domain !== normalized, 'DOMAIN_UNCHANGED', '新域名与当前绑定域名相同', 409);
        const latest = repository.latestApprovedDomainMigrationByLicense(licenseId);
        if (hours > 0 && latest?.reviewed_at) {
          const nextAllowed = new Date(new Date(latest.reviewed_at).getTime() + hours * 60 * 60 * 1000);
          invariant(nowDate >= nextAllowed, 'DOMAIN_MIGRATION_COOLDOWN', `域名换绑冷却中，下次可操作时间：${nextAllowed.toISOString()}`, 429,
            { next_allowed_at: nextAllowed.toISOString() });
        }
        const request = repository.createDomainMigration({
          licenseId, previousDomain: license.bound_domain, requestedDomain: normalized, reason: note, now,
        });
        const updated = repository.changeLicenseDomain(licenseId, normalized, now);
        repository.revokeInstallReceiptsByLicense(licenseId, now);
        repository.revokeActivationsByLicense(licenseId, now);
        const reviewed = repository.decideDomainMigration(request.id, 'approved', null, 'customer-self-service', now);
        invariant(reviewed, 'DOMAIN_MIGRATION_RACE', '域名换绑正在被另一个请求处理', 409);
        repository.audit({
          actorType: 'customer', actorId, action: 'license.domain_migration_self_service',
          subjectType: 'domain_migration', subjectId: request.id,
          metadata: { previous_domain: license.bound_domain, requested_domain: normalized, generation: updated.generation }, now,
        });
        return { request: reviewed, license: updated };
      });
    },

    claimBuild({ buildTicket, artifactSha256 = null, installKeyTtlSeconds = null }) {
      const nowDate = clock();
      const now = nowDate.toISOString();
      return transaction(database, () => {
        const ticket = repository.ticketByHash(hashSecret(buildTicket, config.pepper));
        invariant(ticket, 'BUILD_TICKET_NOT_FOUND', '打包票据无效', 404);
        invariant(ticket.status === 'created', 'BUILD_TICKET_USED', '打包票据已经使用', 409);
        invariant(new Date(ticket.expires_at) >= nowDate, 'BUILD_TICKET_EXPIRED', '打包票据已过期', 410);
        invariant(ticket.license_status === LICENSE_STATUS.ACTIVE, 'LICENSE_INACTIVE', '授权已暂停或撤销', 403);
        invariant(repository.claimTicket(ticket.id, now), 'BUILD_TICKET_RACE', '打包票据正在被另一个任务使用', 409);

        const packageSecret = newPackageSecret();
        const installKey = newInstallKey();
        const buildId = newId('bld');
        const packageId = `pkg_${createHash('sha256').update(`${buildId}:${packageSecret}`).digest('hex').slice(0, 32)}`;
        const watermark = createHash('sha256').update(`${ticket.license_id}:${buildId}:${packageId}`).digest('hex');
        const build = repository.createBuild({
          id: buildId,
          licenseId: ticket.license_id,
          ticketId: ticket.id,
          version: ticket.requested_version,
          domain: ticket.requested_domain,
          packageId,
          packageSecretHash: hashSecret(packageSecret, config.pepper),
          artifactSha256,
          now,
        });
        repository.createInstallKey({
          id: newId('isk'), buildId, keyPrefix: keyPrefix(installKey),
          keyHash: hashSecret(installKey, config.pepper),
          expiresAt: installKeyTtlSeconds ? addSeconds(nowDate, installKeyTtlSeconds) : null,
          now,
        });
        invariant(repository.consumeTicket(ticket.id, now), 'BUILD_TICKET_STATE_ERROR', '打包票据状态异常', 409);
        repository.audit({
          actorType: 'worker', action: 'build.created', subjectType: 'build', subjectId: buildId,
          metadata: { package_id: packageId, version: build.version, domain: build.domain }, now,
        });
        return {
          buildId,
          product: ticket.product_code,
          version: build.version,
          domain: build.domain,
          packageId,
          packageSecret,
          installKey,
          watermark,
          packageManifestToken: signCompactToken(packageManifestPayload({
            buildId, packageId, product: ticket.product_code, version: build.version, domain: build.domain, watermark,
          }, nowDate), packagePrivateKey),
        };
      });
    },

    claimBuildForJob({ licenseId, version, domain }) {
      invariant(version?.trim(), 'VERSION_REQUIRED', '必须提供主题版本');
      const normalizedDomain = canonicalizeDomain(domain);
      const nowDate = clock();
      const now = nowDate.toISOString();
      const buildTicket = transaction(database, () => {
        const license = repository.licenseById(licenseId);
        invariant(license, 'LICENSE_NOT_FOUND', '授权不存在', 404);
        invariant(license.status === LICENSE_STATUS.ACTIVE, 'LICENSE_INACTIVE', '授权已暂停或撤销', 403);
        invariant(license.bound_domain === normalizedDomain, 'LICENSE_DOMAIN_MISMATCH', '构建域名与固定 Key 绑定域名不一致', 403);
        const source = repository.sourceVersionByProductVersion(license.product_code, version.trim());
        invariant(source && source.status === 'active', 'SOURCE_VERSION_NOT_READY', '当前主题版本不可构建', 409);
        if (license.update_until) invariant(new Date(source.published_at ?? source.created_at) <= new Date(license.update_until), 'UPDATE_WINDOW_EXPIRED', '该版本发布时间已超出更新服务期限', 403);
        const recent = repository.recentBuildCount(license.id, startOfRollingDay(nowDate));
        invariant(recent < license.max_builds_per_day, 'BUILD_RATE_LIMITED', '过去 24 小时打包次数已达到上限', 429);
        const ticket = newBuildTicket();
        repository.createTicket({
          id: newId('btk'),
          licenseId: license.id,
          tokenHash: hashSecret(ticket, config.pepper),
          version: version.trim(),
          domain: normalizedDomain,
          expiresAt: addSeconds(nowDate, config.buildTicketTtlSeconds),
          now,
        });
        return ticket;
      });
      return this.claimBuild({ buildTicket });
    },

    unlockInstall({ installKey, buildId, packageProof, domain, backendUrl, installationId }) {
      invariant(installationId?.trim().length >= 12, 'INSTALLATION_ID_INVALID', '安装环境 ID 无效');
      const normalizedDomain = canonicalizeDomain(domain);
      const backendOrigin = canonicalizeBackendOrigin(backendUrl);
      const nowDate = clock();
      const now = nowDate.toISOString();
      return transaction(database, () => {
        const keyRecord = repository.installKeyByHash(hashSecret(installKey, config.pepper));
        invariant(keyRecord, 'INSTALL_KEY_NOT_FOUND', '本次安装 Key 无效', 404);
        invariant(keyRecord.status === 'available', 'INSTALL_KEY_USED', '本次安装 Key 已经使用', 409);
        if (keyRecord.expires_at) invariant(new Date(keyRecord.expires_at) >= nowDate, 'INSTALL_KEY_EXPIRED', '本次安装 Key 已过期', 410);
        invariant(keyRecord.build_id === buildId, 'BUILD_MISMATCH', '安装 Key 与当前安装包不匹配', 403);
        invariant(keyRecord.domain === normalizedDomain && keyRecord.bound_domain === normalizedDomain, 'DOMAIN_MISMATCH', '当前域名与打包授权域名不一致', 403);
        invariant(keyRecord.license_status === LICENSE_STATUS.ACTIVE, 'LICENSE_INACTIVE', '授权已暂停或撤销', 403);
        invariant(keyRecord.build_status === 'ready', 'BUILD_NOT_UNLOCKABLE', '当前安装包状态不允许安装解锁', 409);
        invariant(secretMatches(packageProof, repository.buildById(buildId).package_secret_hash, config.pepper), 'PACKAGE_PROOF_INVALID', '安装包身份校验失败', 403);
        invariant(repository.consumeInstallKey(keyRecord.id, now), 'INSTALL_KEY_RACE', '安装 Key 正在被另一个环境使用', 409);
        invariant(repository.markBuildUnlocked(buildId), 'BUILD_UNLOCK_RACE', '当前安装包正在被另一个环境解锁', 409);

        const receiptSecret = newInstallReceiptSecret();
        const receipt = repository.createInstallReceipt({
          id: newId('irc'), licenseId: keyRecord.license_id, buildId,
          receiptSecretHash: hashSecret(receiptSecret, config.pepper),
          domain: normalizedDomain, backendOrigin, installationId: installationId.trim(),
          generation: keyRecord.license_generation, now,
        });
        repository.audit({
          actorType: 'installation', actorId: receipt.id, action: 'installation.unlocked',
          subjectType: 'install_receipt', subjectId: receipt.id,
          metadata: { domain: normalizedDomain, backend_origin: backendOrigin, build_id: buildId }, now,
        });
        repository.recordLicenseEvent({
          licenseId: keyRecord.license_id, eventType: 'installation.unlocked', buildId,
          installationId: installationId.trim(), actorType: 'installation', actorId: receipt.id, now,
        });
        return { receiptId: receipt.id, receiptSecret, unlockedAt: now };
      });
    },

    activate({
      licenseKey, installReceiptId, installReceiptSecret, buildId, packageProof, domain, backendUrl,
      installationId, installationPublicKey = null, challengeId = null, challengeSignature = null,
    }) {
      invariant(installationId?.trim().length >= 12, 'INSTALLATION_ID_INVALID', '安装环境 ID 无效');
      invariant(typeof licenseKey === 'string' && licenseKey.length >= 12, 'LICENSE_KEY_REQUIRED', '必须输入固定授权 Key');
      invariant(typeof installReceiptId === 'string' && installReceiptId.startsWith('irc_'), 'INSTALL_RECEIPT_REQUIRED', '缺少有效的安装解锁凭证');
      invariant(typeof installReceiptSecret === 'string' && installReceiptSecret.startsWith('IRC_'), 'INSTALL_RECEIPT_REQUIRED', '缺少有效的安装解锁凭证');
      const normalizedDomain = canonicalizeDomain(domain);
      const backendOrigin = canonicalizeBackendOrigin(backendUrl);
      const nowDate = clock();
      const now = nowDate.toISOString();
      return transaction(database, () => {
        const receipt = repository.installReceiptById(installReceiptId);
        invariant(receipt, 'INSTALL_RECEIPT_NOT_FOUND', '安装解锁凭证不存在', 404);
        invariant(secretMatches(installReceiptSecret, receipt.receipt_secret_hash, config.pepper), 'INSTALL_RECEIPT_INVALID', '安装解锁凭证无效', 401);
        invariant(receipt.status === 'unlocked', 'INSTALL_RECEIPT_USED', '安装解锁凭证已用于正式激活', 409);
        invariant(receipt.build_id === buildId, 'BUILD_MISMATCH', '安装解锁凭证与当前安装包不匹配', 403);
        invariant(receipt.domain === normalizedDomain && receipt.bound_domain === normalizedDomain, 'DOMAIN_MISMATCH', '当前域名与安装解锁凭证不一致', 403);
        invariant(receipt.backend_origin === backendOrigin, 'BACKEND_MISMATCH', 'Xboard 后台地址与安装解锁凭证不一致', 403);
        invariant(receipt.installation_id === installationId.trim(), 'INSTALLATION_MISMATCH', '当前安装环境与安装解锁凭证不一致', 403);
        invariant(receipt.build_status === 'package_unlocked', 'BUILD_NOT_UNLOCKED', '当前安装包尚未完成安装解锁', 409);
        invariant(receipt.license_status === LICENSE_STATUS.ACTIVE, 'LICENSE_INACTIVE', '授权已暂停或撤销', 403);
        invariant(receipt.generation === receipt.license_generation, 'LICENSE_ROTATED', '固定 Key 已轮换，请重新构建并安装', 403);
        invariant(secretMatches(packageProof, receipt.package_secret_hash, config.pepper), 'PACKAGE_PROOF_INVALID', '安装包身份校验失败', 403);

        const fixedLicense = repository.licenseByHash(hashSecret(licenseKey, config.pepper));
        invariant(fixedLicense && fixedLicense.id === receipt.license_id, 'LICENSE_KEY_MISMATCH', '固定授权 Key 与当前安装包不匹配', 403);
        invariant(fixedLicense.status === LICENSE_STATUS.ACTIVE, 'LICENSE_INACTIVE', '授权已暂停或撤销', 403);
        invariant(fixedLicense.generation === receipt.generation, 'LICENSE_ROTATED', '固定 Key 已轮换，请重新构建并安装', 403);
        const proof = consumeInstallationProof({
          purpose: 'activation',
          context: { install_receipt_id: installReceiptId, build_id: buildId, domain: normalizedDomain, backend_origin: backendOrigin },
          installationId: installationId.trim(), publicKey: installationPublicKey,
          challengeId, signature: challengeSignature, now,
        });
        const sameEnvironment = repository.activeActivationForEnvironment(
          receipt.license_id, normalizedDomain, backendOrigin, installationId.trim(),
        );
        const activeCount = repository.countActiveActivationsForLicense(receipt.license_id);
        invariant(sameEnvironment || activeCount < fixedLicense.max_activations, 'ACTIVATION_LIMIT_REACHED', '该授权已达到允许的激活数量', 409);
        invariant(repository.activateInstallReceipt(receipt.id, now), 'INSTALL_RECEIPT_RACE', '安装解锁凭证正在被另一个请求使用', 409);

        repository.supersedeActivations(receipt.license_id, normalizedDomain, backendOrigin, installationId.trim(), now);
        const refreshSecret = newRefreshSecret();
        const activation = repository.createActivation({
          id: newId('act'), licenseId: receipt.license_id, buildId,
          domain: normalizedDomain, backendOrigin, installationId: installationId.trim(),
          generation: receipt.generation,
          refreshSecretHash: hashSecret(refreshSecret, config.pepper),
          identityMode: proof ? 'server_key' : 'legacy',
          installationPublicKeyFingerprint: proof?.fingerprint ?? null,
          now,
        });
        if (proof) repository.registerInstallationIdentity({
          installationId: proof.installationId, licenseId: receipt.license_id,
          publicKeyPem: proof.publicKey, publicKeyFingerprint: proof.fingerprint, now,
        });
        repository.markBuildActivated(buildId, now);
        repository.audit({
          actorType: 'installation', actorId: activation.id, action: 'activation.created',
          subjectType: 'activation', subjectId: activation.id,
          metadata: { domain: normalizedDomain, backend_origin: backendOrigin, build_id: buildId, install_receipt_id: receipt.id }, now,
        });
        repository.recordLicenseEvent({
          licenseId: receipt.license_id, eventType: 'activation.created', buildId,
          activationId: activation.id, installationId: installationId.trim(),
          actorType: 'installation', actorId: activation.id, now,
        });
        return {
          activationId: activation.id,
          refreshSecret,
          token: signCompactToken(activationPayload(activation, nowDate), activationPrivateKey),
          expiresAt: addSeconds(nowDate, config.activationTokenTtlSeconds),
        };
      });
    },

    refresh({
      activationId, refreshSecret, domain, installationId, backendUrl = null,
      installationPublicKey = null, challengeId = null, challengeSignature = null,
    }) {
      const normalizedDomain = canonicalizeDomain(domain);
      const nowDate = clock();
      const activation = repository.activationById(activationId);
      invariant(activation, 'ACTIVATION_NOT_FOUND', '激活记录不存在', 404);
      invariant(activation.status === 'active', 'ACTIVATION_INACTIVE', '激活记录已失效', 403);
      invariant(activation.license_status === LICENSE_STATUS.ACTIVE, 'LICENSE_INACTIVE', '授权已暂停或撤销', 403);
      invariant(activation.domain === activation.bound_domain, 'LICENSE_DOMAIN_MISMATCH', '授权域名已经迁移，请重新打包并激活', 403);
      invariant(activation.license_generation === activation.generation, 'LICENSE_ROTATED', '固定 Key 已轮换，请重新打包并激活', 403);
      invariant(activation.domain === normalizedDomain && activation.installation_id === installationId, 'ENVIRONMENT_MISMATCH', '当前域名或安装环境与授权不匹配', 403);
      if (backendUrl) invariant(activation.backend_origin === canonicalizeBackendOrigin(backendUrl), 'BACKEND_MISMATCH', 'Xboard 后台地址与授权不匹配', 403);
      invariant(secretMatches(refreshSecret, activation.refresh_secret_hash, config.pepper), 'REFRESH_SECRET_INVALID', '刷新凭证无效', 401);
      if (activation.identity_mode === 'server_key') {
        const identity = repository.installationIdentityById(installationId);
        invariant(identity && identity.status === 'active', 'INSTALLATION_IDENTITY_FENCED', '旧服务器安装身份已被隔离，不能继续刷新', 403);
        invariant(identity.public_key_fingerprint === activation.installation_public_key_fingerprint, 'INSTALLATION_IDENTITY_MISMATCH', '安装身份与激活记录不一致', 403);
        consumeInstallationProof({
          purpose: 'refresh',
          context: { activation_id: activationId, domain: normalizedDomain, backend_origin: activation.backend_origin },
          installationId, publicKey: installationPublicKey,
          challengeId, signature: challengeSignature, now: nowDate.toISOString(),
        });
        repository.touchInstallationIdentity(installationId, nowDate.toISOString());
      }
      repository.updateActivationSeen(activation.id, nowDate.toISOString());
      return {
        token: signCompactToken(activationPayload(activation, nowDate), activationPrivateKey),
        expiresAt: addSeconds(nowDate, config.activationTokenTtlSeconds),
      };
    },

    issueProductMigrationGrant({
      activationId, refreshSecret, targetInstallationPublicKey,
      installationPublicKey, challengeId, challengeSignature,
    }) {
      const nowDate = clock();
      const now = nowDate.toISOString();
      const activation = repository.activationById(activationId);
      invariant(activation, 'ACTIVATION_NOT_FOUND', '源服务器激活记录不存在', 404);
      invariant(activation.status === 'active', 'ACTIVATION_INACTIVE', '源服务器激活已经失效', 403);
      invariant(activation.identity_mode === 'server_key', 'PRODUCT_MIGRATION_REQUIRES_SERVER_IDENTITY', '旧服务器必须先启用安装身份密钥才能迁机', 409);
      invariant(secretMatches(refreshSecret, activation.refresh_secret_hash, config.pepper), 'REFRESH_SECRET_INVALID', '源服务器刷新凭证无效', 401);
      const sourceIdentity = repository.installationIdentityById(activation.installation_id);
      invariant(sourceIdentity && sourceIdentity.status === 'active', 'INSTALLATION_IDENTITY_FENCED', '源服务器安装身份不可用于迁机', 403);
      let targetFingerprint;
      let targetInstallationId;
      try {
        targetFingerprint = installationFingerprint(targetInstallationPublicKey);
        targetInstallationId = installationIdFromPublicKey(targetInstallationPublicKey);
      } catch {
        invariant(false, 'TARGET_INSTALLATION_PUBLIC_KEY_INVALID', '新服务器安装身份公钥无效');
      }
      invariant(targetInstallationId !== activation.installation_id, 'MIGRATION_TARGET_SAME_AS_SOURCE', '新旧服务器安装身份不能相同', 409);
      const context = { activation_id: activationId, target_public_key_fingerprint: targetFingerprint };
      const grantToken = newProductMigrationGrant();
      const grantId = newId('pmg');
      transaction(database, () => {
        consumeInstallationProof({
          purpose: 'migration_issue', context, installationId: activation.installation_id,
          publicKey: installationPublicKey, challengeId, signature: challengeSignature, now,
        });
        repository.createProductMigrationGrant({
          id: grantId, licenseId: activation.license_id,
          sourceInstallationId: activation.installation_id,
          targetPublicKeyFingerprint: targetFingerprint,
          tokenHash: hashSecret(grantToken, config.pepper),
          expiresAt: addSeconds(nowDate, 600), rollbackUntil: addSeconds(nowDate, 86400), now,
        });
        repository.recordLicenseEvent({
          licenseId: activation.license_id, eventType: 'product_migration.grant_issued',
          activationId, installationId: activation.installation_id,
          actorType: 'installation', actorId: activation.installation_id,
          metadata: { grant_id: grantId, target_public_key_fingerprint: targetFingerprint }, now,
        });
      });
      return {
        grantId, grantToken, targetInstallationId,
        expiresAt: addSeconds(nowDate, 600), rollbackUntil: addSeconds(nowDate, 86400),
      };
    },

    acceptProductMigration({
      grantToken, buildId, packageProof, domain, backendUrl,
      installationId, installationPublicKey, challengeId, challengeSignature,
    }) {
      const normalizedDomain = canonicalizeDomain(domain);
      const backendOrigin = canonicalizeBackendOrigin(backendUrl);
      const nowDate = clock();
      const now = nowDate.toISOString();
      return transaction(database, () => {
        const grant = repository.productMigrationGrantByHash(hashSecret(grantToken, config.pepper));
        invariant(grant, 'PRODUCT_MIGRATION_GRANT_INVALID', '迁机凭证无效', 404);
        invariant(grant.status === 'issued', 'PRODUCT_MIGRATION_GRANT_USED', '迁机凭证已经使用', 409);
        invariant(grant.expires_at >= now, 'PRODUCT_MIGRATION_GRANT_EXPIRED', '迁机凭证已过期', 401);
        const sourceActivation = repository.activeActivationByInstallation(grant.license_id, grant.source_installation_id);
        invariant(sourceActivation, 'PRODUCT_MIGRATION_SOURCE_CHANGED', '源服务器激活所有权已经变化', 409);
        const build = repository.buildById(buildId);
        invariant(build && build.license_id === grant.license_id, 'BUILD_MISMATCH', '迁机凭证与当前安装包不匹配', 403);
        invariant(build.domain === normalizedDomain, 'DOMAIN_MISMATCH', '迁机域名与安装包不一致', 403);
        invariant(secretMatches(packageProof, build.package_secret_hash, config.pepper), 'PACKAGE_PROOF_INVALID', '安装包身份校验失败', 403);
        invariant(installationFingerprint(installationPublicKey) === grant.target_public_key_fingerprint, 'MIGRATION_TARGET_IDENTITY_MISMATCH', '新服务器安装身份与迁机凭证不一致', 403);
        const context = { grant_id: grant.id, build_id: buildId, domain: normalizedDomain, backend_origin: backendOrigin };
        const proof = consumeInstallationProof({
          purpose: 'migration_accept', context, installationId,
          publicKey: installationPublicKey, challengeId, signature: challengeSignature, now,
        });
        invariant(repository.consumeProductMigrationGrant(grant.id, now), 'PRODUCT_MIGRATION_GRANT_RACE', '迁机凭证正在被另一个请求使用', 409);
        repository.fenceActivationsByInstallation(grant.license_id, grant.source_installation_id, now);
        repository.fenceInstallationIdentity(grant.source_installation_id, now);
        repository.registerInstallationIdentity({
          installationId: proof.installationId, licenseId: grant.license_id,
          publicKeyPem: proof.publicKey, publicKeyFingerprint: proof.fingerprint, now,
        });
        const refreshSecret = newRefreshSecret();
        const license = repository.licenseById(grant.license_id);
        const activation = repository.createActivation({
          id: newId('act'), licenseId: grant.license_id, buildId,
          domain: normalizedDomain, backendOrigin, installationId: proof.installationId,
          generation: license.generation, refreshSecretHash: hashSecret(refreshSecret, config.pepper),
          identityMode: 'server_key', installationPublicKeyFingerprint: proof.fingerprint, now,
        });
        repository.recordLicenseEvent({
          licenseId: grant.license_id, eventType: 'product_migration.completed', buildId,
          activationId: activation.id, installationId: proof.installationId,
          actorType: 'installation', actorId: proof.installationId,
          metadata: { grant_id: grant.id, source_installation_id: grant.source_installation_id }, now,
        });
        return {
          activationId: activation.id, refreshSecret,
          token: signCompactToken(activationPayload(activation, nowDate), activationPrivateKey),
          expiresAt: addSeconds(nowDate, config.activationTokenTtlSeconds),
          sourceStatus: 'fenced', targetStatus: 'active',
        };
      });
    },

    rotateLicenseKey({ licenseId, actorId = null }) {
      const license = repository.licenseById(licenseId);
      invariant(license, 'LICENSE_NOT_FOUND', '授权不存在', 404);
      const plainKey = newLicenseKey(license.product_code);
      const now = iso(clock);
      const updated = transaction(database, () => {
        const result = repository.rotateLicense(licenseId, keyPrefix(plainKey), hashSecret(plainKey, config.pepper), sealSecret(plainKey, licenseEncryptionKey), now);
        repository.revokeInstallReceiptsByLicense(licenseId, now);
        repository.recordLicenseEvent({ licenseId, eventType: 'license.key_rotated', actorType: 'admin', actorId, now });
        return result;
      });
      repository.audit({ actorType: 'admin', actorId, action: 'license.key_rotated', subjectType: 'license', subjectId: licenseId, now });
      return { license: updated, licenseKey: plainKey };
    },

    revealLicenseKey({ licenseId, actorId = null }) {
      const license = repository.licenseById(licenseId);
      invariant(license, 'LICENSE_NOT_FOUND', '授权不存在', 404);
      invariant(license.key_encrypted, 'LICENSE_KEY_LEGACY', '历史 Key 无法恢复，请先轮换 Key 后再查看', 409);
      const now = iso(clock);
      const licenseKey = openSecret(license.key_encrypted, licenseEncryptionKey);
      repository.audit({ actorType: 'admin', actorId, action: 'license.key_viewed', subjectType: 'license', subjectId: licenseId, now });
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
        repository.revokeInstallReceiptsByLicense(licenseId, now);
        repository.revokeActivationsByLicense(licenseId, now);
        repository.recordLicenseEvent({
          licenseId, eventType: 'license.domain_changed', actorType: 'admin', actorId,
          metadata: { previous_domain: license.bound_domain, domain: normalized }, now,
        });
        return result;
      });
      repository.audit({
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
        if (status === 'revoked') repository.revokeInstallReceiptsByLicense(licenseId, now);
        repository.recordLicenseEvent({
          licenseId, eventType: `license.${status}`, actorType: 'admin', actorId,
          metadata: { previous_status: license.status }, now,
        });
        return result;
      });
      repository.audit({
        actorType: 'admin', actorId, action: `license.${status}`, subjectType: 'license', subjectId: licenseId,
        metadata: { previous_status: license.status }, now,
      });
      return updated;
    },

    changeLicensePlan({ licenseId, planCode, actorId = null }) {
      const license = repository.licenseById(licenseId);
      invariant(license, 'LICENSE_NOT_FOUND', '授权不存在', 404);
      invariant(license.status !== 'deleting', 'LICENSE_DELETING', '授权正在永久删除', 409);
      const plan = repository.planByCode(String(planCode ?? '').trim().toLowerCase());
      invariant(plan && plan.status === 'active', 'LICENSE_PLAN_INVALID', '授权套餐不存在或已停用');
      invariant(license.plan_id !== plan.id, 'LICENSE_PLAN_UNCHANGED', '授权套餐没有变化', 409);
      const now = iso(clock);
      const updated = transaction(database, () => {
        const result = repository.changeLicensePlan(licenseId, plan.id, now);
        repository.revokeActivationsByLicense(licenseId, now);
        repository.recordLicenseEvent({
          licenseId, eventType: 'license.plan_changed', actorType: 'admin', actorId,
          metadata: { previous_plan: license.plan_code ?? 'legacy', plan_code: plan.code }, now,
        });
        return result;
      });
      repository.audit({
        actorType: 'admin', actorId, action: 'license.plan_changed', subjectType: 'license', subjectId: licenseId,
        metadata: { previous_plan: license.plan_code ?? 'legacy', plan_code: plan.code }, now,
      });
      return updated;
    },
  };
}

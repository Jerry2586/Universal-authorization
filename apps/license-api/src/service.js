import { createHash } from 'node:crypto';
import { canonicalizeBackendOrigin, canonicalizeDomain } from '../../../packages/core/src/canonicalize.js';
import { invariant } from '../../../packages/core/src/errors.js';
import {
  keyPrefix, newBuildTicket, newId, newInstallKey, newInstallReceiptSecret, newLicenseKey, newPackageSecret, newRefreshSecret,
} from '../../../packages/core/src/identifiers.js';
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

export function createLicenseService({ database, repository, config, privateKey, clock = () => new Date() }) {
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
      iat: Math.floor(nowDate.getTime() / 1000),
      exp: Math.floor(nowDate.getTime() / 1000) + config.activationTokenTtlSeconds,
      offline_until: Math.floor(nowDate.getTime() / 1000) + config.activationTokenTtlSeconds + (config.offlineGraceSeconds ?? 2592000),
      capabilities: ['settings:read', 'settings:write', 'theme:enable', 'xboard:connect', 'protected:read', 'updates:read'],
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
          iat: Math.floor(now.getTime() / 1000), exp: Math.floor(now.getTime() / 1000) + 86400 }, privateKey),
      };
    },

    issueLicense({ productCode = 'appgog', customerRef, domain = null, updateUntil = null, maxBuildsPerDay = 3, maxActivations = 1, actorId = null }) {
      const product = this.ensureProduct({ code: productCode, name: productCode.toUpperCase() });
      invariant(customerRef?.trim(), 'CUSTOMER_REQUIRED', '必须提供客户编号');
      invariant(Number.isInteger(maxBuildsPerDay) && maxBuildsPerDay >= 1 && maxBuildsPerDay <= 50, 'BUILD_LIMIT_INVALID', '每日打包上限必须为 1 到 50 的整数');
      invariant(Number.isInteger(maxActivations) && maxActivations >= 1 && maxActivations <= 20, 'ACTIVATION_LIMIT_INVALID', '激活数量上限必须为 1 到 20 的整数');
      if (updateUntil) invariant(!Number.isNaN(new Date(updateUntil).getTime()), 'UPDATE_DATE_INVALID', '更新到期时间无效');
      const plainKey = newLicenseKey(product.code);
      const now = iso(clock);
      const license = repository.createLicense({
        id: newId('lic'),
        productId: product.id,
        customerRef: customerRef.trim(),
        keyPrefix: keyPrefix(plainKey),
        keyHash: hashSecret(plainKey, config.pepper),
        keyEncrypted: sealSecret(plainKey, licenseEncryptionKey),
        status: LICENSE_STATUS.ACTIVE,
        boundDomain: domain ? canonicalizeDomain(domain) : null,
        updateUntil,
        maxBuildsPerDay,
        maxActivations,
        now,
      });
      repository.audit({ actorType: 'admin', actorId, action: 'license.issued', subjectType: 'license', subjectId: license.id, now });
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
          }, nowDate), privateKey),
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
        return { receiptId: receipt.id, receiptSecret, unlockedAt: now };
      });
    },

    activate({ licenseKey, installReceiptId, installReceiptSecret, buildId, packageProof, domain, backendUrl, installationId }) {
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
          refreshSecretHash: hashSecret(refreshSecret, config.pepper), now,
        });
        repository.markBuildActivated(buildId, now);
        repository.audit({
          actorType: 'installation', actorId: activation.id, action: 'activation.created',
          subjectType: 'activation', subjectId: activation.id,
          metadata: { domain: normalizedDomain, backend_origin: backendOrigin, build_id: buildId, install_receipt_id: receipt.id }, now,
        });
        return {
          activationId: activation.id,
          refreshSecret,
          token: signCompactToken(activationPayload(activation, nowDate), privateKey),
          expiresAt: addSeconds(nowDate, config.activationTokenTtlSeconds),
        };
      });
    },

    refresh({ activationId, refreshSecret, domain, installationId, backendUrl = null }) {
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
      repository.updateActivationSeen(activation.id, nowDate.toISOString());
      return {
        token: signCompactToken(activationPayload(activation, nowDate), privateKey),
        expiresAt: addSeconds(nowDate, config.activationTokenTtlSeconds),
      };
    },

    rotateLicenseKey({ licenseId, actorId = null }) {
      const license = repository.licenseById(licenseId);
      invariant(license, 'LICENSE_NOT_FOUND', '授权不存在', 404);
      const plainKey = newLicenseKey(license.product_code);
      const now = iso(clock);
      const updated = transaction(database, () => {
        const result = repository.rotateLicense(licenseId, keyPrefix(plainKey), hashSecret(plainKey, config.pepper), sealSecret(plainKey, licenseEncryptionKey), now);
        repository.revokeInstallReceiptsByLicense(licenseId, now);
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
        return result;
      });
      repository.audit({
        actorType: 'admin', actorId, action: `license.${status}`, subjectType: 'license', subjectId: licenseId,
        metadata: { previous_status: license.status }, now,
      });
      return updated;
    },
  };
}

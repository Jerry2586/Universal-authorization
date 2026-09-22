import { createHash } from 'node:crypto';
import { canonicalizeBackendOrigin, canonicalizeDomain } from '../../../packages/core/src/canonicalize.js';
import { invariant } from '../../../packages/core/src/errors.js';
import {
  keyPrefix, newBuildTicket, newId, newInstallKey, newLicenseKey, newPackageSecret, newRefreshSecret,
} from '../../../packages/core/src/identifiers.js';
import { hashSecret, secretMatches } from '../../../packages/core/src/security.js';
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

    issueLicense({ productCode = 'appgog', customerRef, domain = null, updateUntil = null, maxBuildsPerDay = 3, actorId = null }) {
      const product = this.ensureProduct({ code: productCode, name: productCode.toUpperCase() });
      invariant(customerRef?.trim(), 'CUSTOMER_REQUIRED', '必须提供客户编号');
      invariant(Number.isInteger(maxBuildsPerDay) && maxBuildsPerDay >= 1 && maxBuildsPerDay <= 50, 'BUILD_LIMIT_INVALID', '每日打包上限必须为 1 到 50 的整数');
      if (updateUntil) invariant(!Number.isNaN(new Date(updateUntil).getTime()), 'UPDATE_DATE_INVALID', '更新到期时间无效');
      const plainKey = newLicenseKey(product.code);
      const now = iso(clock);
      const license = repository.createLicense({
        id: newId('lic'),
        productId: product.id,
        customerRef: customerRef.trim(),
        keyPrefix: keyPrefix(plainKey),
        keyHash: hashSecret(plainKey, config.pepper),
        status: LICENSE_STATUS.ACTIVE,
        boundDomain: domain ? canonicalizeDomain(domain) : null,
        updateUntil,
        maxBuildsPerDay,
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

    activate({ installKey, licenseKey, buildId, packageProof, domain, backendUrl, installationId }) {
      invariant(installationId?.trim().length >= 12, 'INSTALLATION_ID_INVALID', '安装环境 ID 无效');
      invariant(typeof licenseKey === 'string' && licenseKey.length >= 12, 'LICENSE_KEY_REQUIRED', '必须输入固定授权 Key');
      const normalizedDomain = canonicalizeDomain(domain);
      const backendOrigin = canonicalizeBackendOrigin(backendUrl);
      const nowDate = clock();
      const now = nowDate.toISOString();
      return transaction(database, () => {
        const keyRecord = repository.installKeyByHash(hashSecret(installKey, config.pepper));
        invariant(keyRecord, 'INSTALL_KEY_NOT_FOUND', '本次安装 Key 无效', 404);
        const fixedLicense = repository.licenseByHash(hashSecret(licenseKey, config.pepper));
        invariant(fixedLicense && fixedLicense.id === keyRecord.license_id, 'LICENSE_KEY_MISMATCH', '固定授权 Key 与本次安装包不匹配', 403);
        invariant(keyRecord.status === 'available', 'INSTALL_KEY_USED', '本次安装 Key 已经使用', 409);
        if (keyRecord.expires_at) invariant(new Date(keyRecord.expires_at) >= nowDate, 'INSTALL_KEY_EXPIRED', '本次安装 Key 已过期', 410);
        invariant(keyRecord.build_id === buildId, 'BUILD_MISMATCH', '安装 Key 与当前安装包不匹配', 403);
        invariant(keyRecord.domain === normalizedDomain && keyRecord.bound_domain === normalizedDomain, 'DOMAIN_MISMATCH', '当前域名与打包授权域名不一致', 403);
        invariant(keyRecord.license_status === LICENSE_STATUS.ACTIVE, 'LICENSE_INACTIVE', '授权已暂停或撤销', 403);
        invariant(keyRecord.build_status !== 'revoked', 'BUILD_REVOKED', '当前安装包已被撤销', 403);
        invariant(secretMatches(packageProof, repository.buildById(buildId).package_secret_hash, config.pepper), 'PACKAGE_PROOF_INVALID', '安装包身份校验失败', 403);
        invariant(repository.consumeInstallKey(keyRecord.id, now), 'INSTALL_KEY_RACE', '安装 Key 正在被另一个环境使用', 409);

        repository.supersedeActivations(keyRecord.license_id, normalizedDomain, now);
        const refreshSecret = newRefreshSecret();
        const activation = repository.createActivation({
          id: newId('act'), licenseId: keyRecord.license_id, buildId,
          domain: normalizedDomain, backendOrigin, installationId: installationId.trim(),
          generation: keyRecord.license_generation,
          refreshSecretHash: hashSecret(refreshSecret, config.pepper), now,
        });
        repository.markBuildActivated(buildId, now);
        repository.audit({
          actorType: 'installation', actorId: activation.id, action: 'activation.created',
          subjectType: 'activation', subjectId: activation.id,
          metadata: { domain: normalizedDomain, backend_origin: backendOrigin, build_id: buildId }, now,
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
      const updated = repository.rotateLicense(licenseId, keyPrefix(plainKey), hashSecret(plainKey, config.pepper), now);
      repository.audit({ actorType: 'admin', actorId, action: 'license.key_rotated', subjectType: 'license', subjectId: licenseId, now });
      return { license: updated, licenseKey: plainKey };
    },

    changeLicenseDomain({ licenseId, domain, actorId = null }) {
      const license = repository.licenseById(licenseId);
      invariant(license, 'LICENSE_NOT_FOUND', '授权不存在', 404);
      const normalized = canonicalizeDomain(domain);
      invariant(license.bound_domain !== normalized, 'DOMAIN_UNCHANGED', '新域名与当前绑定域名相同', 409);
      const now = iso(clock);
      const updated = repository.changeLicenseDomain(licenseId, normalized, now);
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
      const updated = repository.changeLicenseStatus(licenseId, status, now);
      repository.audit({
        actorType: 'admin', actorId, action: `license.${status}`, subjectType: 'license', subjectId: licenseId,
        metadata: { previous_status: license.status }, now,
      });
      return updated;
    },
  };
}

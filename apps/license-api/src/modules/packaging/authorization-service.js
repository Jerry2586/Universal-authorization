import { createHash } from 'node:crypto';
import { canonicalizeDomain } from '../../../../../packages/core/src/canonicalize.js';
import { invariant } from '../../../../../packages/core/src/errors.js';
import { keyPrefix, newBuildTicket, newId, newInstallKey, newPackageSecret } from '../../../../../packages/core/src/identifiers.js';
import { hashSecret } from '../../../../../packages/core/src/security.js';
import { signCompactToken } from '../../../../../packages/core/src/signing.js';
import { LICENSE_STATUS } from '../../../../../packages/core/src/states.js';
import { transaction } from '../../database.js';
import { addSeconds, startOfRollingDay } from '../shared/service-utils.js';

export function createBuildAuthorizationService({
  database, repository, licensingAccess, entitlementAccess, audit, config, packagePrivateKey, clock = () => new Date(),
}) {
  function packageManifestPayload({ buildId, packageId, product, version, domain, watermark }, nowDate) {
    return {
      iss: config.publicBaseUrl, typ: 'package-manifest', product,
      build_id: buildId, package_id: packageId, version, domain, watermark,
      iat: Math.floor(nowDate.getTime() / 1000),
    };
  }

  function claimBuild({ buildTicket, artifactSha256 = null, installKeyTtlSeconds = null }) {
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
        id: buildId, licenseId: ticket.license_id, ticketId: ticket.id,
        version: ticket.requested_version, domain: ticket.requested_domain, packageId,
        packageSecretHash: hashSecret(packageSecret, config.pepper), artifactSha256, now,
      });
      repository.createInstallKey({
        id: newId('isk'), buildId, keyPrefix: keyPrefix(installKey),
        keyHash: hashSecret(installKey, config.pepper),
        expiresAt: installKeyTtlSeconds ? addSeconds(nowDate, installKeyTtlSeconds) : null, now,
      });
      invariant(repository.consumeTicket(ticket.id, now), 'BUILD_TICKET_STATE_ERROR', '打包票据状态异常', 409);
      audit.record({
        actorType: 'worker', action: 'build.created', subjectType: 'build', subjectId: buildId,
        metadata: { package_id: packageId, version: build.version, domain: build.domain }, now,
      });
      return {
        buildId, product: ticket.product_code, version: build.version, domain: build.domain,
        packageId, packageSecret, installKey, watermark,
        packageManifestToken: signCompactToken(packageManifestPayload({
          buildId, packageId, product: ticket.product_code, version: build.version, domain: build.domain, watermark,
        }, nowDate), packagePrivateKey),
      };
    });
  }

  return Object.freeze({
    authorizeBuild({ licenseKey, version, domain }) {
      invariant(version?.trim(), 'VERSION_REQUIRED', '必须提供主题版本');
      const normalizedDomain = canonicalizeDomain(domain);
      const nowDate = clock();
      const now = nowDate.toISOString();
      return transaction(database, () => {
        let license = licensingAccess.findActiveLicense(licenseKey);
        const source = repository.sourceVersionByProductVersion(license.product_code, version.trim());
        if (source) {
          invariant(source.status === 'active', 'SOURCE_VERSION_NOT_READY', '该主题版本不可构建', 409);
          entitlementAccess.assertVersionAccess({ license, source });
          if (license.update_until) invariant(new Date(source.published_at ?? source.created_at) <= new Date(license.update_until),
            'UPDATE_WINDOW_EXPIRED', '该版本发布时间已超出更新服务期限', 403);
        } else if (license.update_until) {
          invariant(new Date(license.update_until) >= nowDate, 'UPDATE_WINDOW_EXPIRED', '该授权的更新服务已到期', 403);
        }
        license = licensingAccess.bindDomainForBuild(license, normalizedDomain, now);
        const recent = repository.recentBuildCount(license.id, startOfRollingDay(nowDate));
        invariant(recent < license.max_builds_per_day, 'BUILD_RATE_LIMITED', '过去 24 小时打包次数已达到上限', 429);
        const ticket = newBuildTicket();
        const ticketId = newId('btk');
        const expiresAt = addSeconds(nowDate, config.buildTicketTtlSeconds);
        repository.createTicket({
          id: ticketId, licenseId: license.id, tokenHash: hashSecret(ticket, config.pepper),
          version: version.trim(), domain: normalizedDomain, expiresAt, now,
        });
        audit.record({
          actorType: 'customer', actorId: license.id, action: 'build.authorized',
          subjectType: 'build_ticket', subjectId: ticketId,
          metadata: { version: version.trim(), domain: normalizedDomain }, now,
        });
        audit.recordLicenseEvent({
          licenseId: license.id, eventType: 'build.authorized', actorType: 'customer', actorId: license.id,
          metadata: { ticket_id: ticketId, version: version.trim() }, now,
        });
        return { buildTicket: ticket, ticketId, expiresAt, product: license.product_code };
      });
    },
    claimBuild,
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
        entitlementAccess.assertVersionAccess({ license, source });
        if (license.update_until) invariant(new Date(source.published_at ?? source.created_at) <= new Date(license.update_until),
          'UPDATE_WINDOW_EXPIRED', '该版本发布时间已超出更新服务期限', 403);
        const recent = repository.recentBuildCount(license.id, startOfRollingDay(nowDate));
        invariant(recent < license.max_builds_per_day, 'BUILD_RATE_LIMITED', '过去 24 小时打包次数已达到上限', 429);
        const ticket = newBuildTicket();
        repository.createTicket({
          id: newId('btk'), licenseId: license.id, tokenHash: hashSecret(ticket, config.pepper),
          version: version.trim(), domain: normalizedDomain,
          expiresAt: addSeconds(nowDate, config.buildTicketTtlSeconds), now,
        });
        return ticket;
      });
      return claimBuild({ buildTicket });
    },
  });
}

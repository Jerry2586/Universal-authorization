import { canonicalizeBackendOrigin, canonicalizeDomain } from '../../../../../packages/core/src/canonicalize.js';
import { invariant } from '../../../../../packages/core/src/errors.js';
import {
  newId, newInstallReceiptSecret, newInstallationChallengeNonce,
  newProductMigrationGrant, newRefreshSecret,
} from '../../../../../packages/core/src/identifiers.js';
import {
  installationContextHash, installationFingerprint, installationIdFromPublicKey, verifyInstallationProof,
} from '../../../../../packages/core/src/installation-proof.js';
import { hashSecret, secretMatches } from '../../../../../packages/core/src/security.js';
import { signCompactToken } from '../../../../../packages/core/src/signing.js';
import { LICENSE_STATUS } from '../../../../../packages/core/src/states.js';
import { transaction } from '../../database.js';
import { capabilitiesFor } from '../entitlement/capabilities.js';
import { addSeconds } from '../shared/service-utils.js';

export function createActivationService({
  database, repository, audit, config, activationPrivateKey, clock = () => new Date(),
}) {
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
      iss: config.publicBaseUrl, sub: activation.id, typ: 'activation', product: activation.product_code,
      license_id: activation.license_id, license_generation: activation.license_generation,
      build_id: activation.build_id, package_id: activation.package_id, version: activation.version,
      domain: activation.domain, backend_origin: activation.backend_origin,
      installation_id: activation.installation_id, installation_identity_mode: activation.identity_mode ?? 'legacy',
      installation_public_key_fingerprint: activation.installation_public_key_fingerprint ?? null,
      iat: Math.floor(nowDate.getTime() / 1000),
      exp: Math.floor(nowDate.getTime() / 1000) + config.activationTokenTtlSeconds,
      offline_until: Math.floor(nowDate.getTime() / 1000) + config.activationTokenTtlSeconds + (config.offlineGraceSeconds ?? 2592000),
      plan: activation.plan_code ?? 'legacy', capabilities: capabilitiesFor(activation),
      limits: JSON.parse(activation.plan_limits_json ?? '{}'),
    };
  }

  const internal = Object.freeze({
    revokeActivationsByLicense: (licenseId, now) => repository.revokeActivationsByLicense(licenseId, now),
    revokeInstallReceiptsByLicense: (licenseId, now) => repository.revokeInstallReceiptsByLicense(licenseId, now),
  });

  return Object.freeze({
    internal,
    createInstallationChallenge({ purpose, publicKey, context = {} }) {
      invariant([
        'activation', 'refresh', 'migration_issue', 'migration_accept',
        'migration_prepare', 'migration_commit', 'migration_rollback',
      ].includes(purpose),
        'INSTALLATION_CHALLENGE_PURPOSE_INVALID', '安装身份挑战用途无效');
      invariant(publicKey && typeof publicKey === 'string' && publicKey.length <= 8192,
        'INSTALLATION_PUBLIC_KEY_INVALID', '安装身份公钥无效');
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
        invariant(keyRecord.domain === normalizedDomain && keyRecord.bound_domain === normalizedDomain,
          'DOMAIN_MISMATCH', '当前域名与打包授权域名不一致', 403);
        invariant(keyRecord.license_status === LICENSE_STATUS.ACTIVE, 'LICENSE_INACTIVE', '授权已暂停或撤销', 403);
        invariant(keyRecord.build_status === 'ready', 'BUILD_NOT_UNLOCKABLE', '当前安装包状态不允许安装解锁', 409);
        invariant(secretMatches(packageProof, repository.buildById(buildId).package_secret_hash, config.pepper),
          'PACKAGE_PROOF_INVALID', '安装包身份校验失败', 403);
        invariant(repository.consumeInstallKey(keyRecord.id, now), 'INSTALL_KEY_RACE', '安装 Key 正在被另一个环境使用', 409);
        invariant(repository.markBuildUnlocked(buildId), 'BUILD_UNLOCK_RACE', '当前安装包正在被另一个环境解锁', 409);
        const receiptSecret = newInstallReceiptSecret();
        const receipt = repository.createInstallReceipt({
          id: newId('irc'), licenseId: keyRecord.license_id, buildId,
          receiptSecretHash: hashSecret(receiptSecret, config.pepper), domain: normalizedDomain,
          backendOrigin, installationId: installationId.trim(), generation: keyRecord.license_generation, now,
        });
        audit.record({
          actorType: 'installation', actorId: receipt.id, action: 'installation.unlocked',
          subjectType: 'install_receipt', subjectId: receipt.id,
          metadata: { domain: normalizedDomain, backend_origin: backendOrigin, build_id: buildId }, now,
        });
        audit.recordLicenseEvent({
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
        invariant(sameEnvironment || activeCount < fixedLicense.max_activations,
          'ACTIVATION_LIMIT_REACHED', '该授权已达到允许的激活数量', 409);
        invariant(repository.activateInstallReceipt(receipt.id, now), 'INSTALL_RECEIPT_RACE', '安装解锁凭证正在被另一个请求使用', 409);
        repository.supersedeActivations(receipt.license_id, normalizedDomain, backendOrigin, installationId.trim(), now);
        const refreshSecret = newRefreshSecret();
        const activation = repository.createActivation({
          id: newId('act'), licenseId: receipt.license_id, buildId, domain: normalizedDomain,
          backendOrigin, installationId: installationId.trim(), generation: receipt.generation,
          refreshSecretHash: hashSecret(refreshSecret, config.pepper),
          identityMode: proof ? 'server_key' : 'legacy', installationPublicKeyFingerprint: proof?.fingerprint ?? null, now,
        });
        if (proof) repository.registerInstallationIdentity({
          installationId: proof.installationId, licenseId: receipt.license_id,
          publicKeyPem: proof.publicKey, publicKeyFingerprint: proof.fingerprint, now,
        });
        repository.markBuildActivated(buildId, now);
        audit.record({
          actorType: 'installation', actorId: activation.id, action: 'activation.created',
          subjectType: 'activation', subjectId: activation.id,
          metadata: { domain: normalizedDomain, backend_origin: backendOrigin, build_id: buildId, install_receipt_id: receipt.id }, now,
        });
        audit.recordLicenseEvent({
          licenseId: receipt.license_id, eventType: 'activation.created', buildId,
          activationId: activation.id, installationId: installationId.trim(),
          actorType: 'installation', actorId: activation.id, now,
        });
        return {
          activationId: activation.id, refreshSecret,
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
      invariant(activation.domain === normalizedDomain && activation.installation_id === installationId,
        'ENVIRONMENT_MISMATCH', '当前域名或安装环境与授权不匹配', 403);
      if (backendUrl) invariant(activation.backend_origin === canonicalizeBackendOrigin(backendUrl),
        'BACKEND_MISMATCH', 'Xboard 后台地址与授权不匹配', 403);
      invariant(secretMatches(refreshSecret, activation.refresh_secret_hash, config.pepper),
        'REFRESH_SECRET_INVALID', '刷新凭证无效', 401);
      if (activation.identity_mode === 'server_key') {
        const identity = repository.installationIdentityById(installationId);
        invariant(identity && identity.status === 'active', 'INSTALLATION_IDENTITY_FENCED', '旧服务器安装身份已被隔离，不能继续刷新', 403);
        invariant(identity.public_key_fingerprint === activation.installation_public_key_fingerprint,
          'INSTALLATION_IDENTITY_MISMATCH', '安装身份与激活记录不一致', 403);
        consumeInstallationProof({
          purpose: 'refresh', context: { activation_id: activationId, domain: normalizedDomain, backend_origin: activation.backend_origin },
          installationId, publicKey: installationPublicKey, challengeId,
          signature: challengeSignature, now: nowDate.toISOString(),
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
      invariant(!repository.installationIdentityById(targetInstallationId),
        'MIGRATION_TARGET_IDENTITY_EXISTS', '新服务器安装身份已经登记，必须生成新的安装身份', 409);
      const context = { activation_id: activationId, target_public_key_fingerprint: targetFingerprint };
      const grantToken = newProductMigrationGrant();
      const grantId = newId('pmg');
      transaction(database, () => {
        consumeInstallationProof({
          purpose: 'migration_issue', context, installationId: activation.installation_id,
          publicKey: installationPublicKey, challengeId, signature: challengeSignature, now,
        });
        repository.createProductMigrationGrant({
          id: grantId, licenseId: activation.license_id, sourceActivationId: activation.id,
          sourceInstallationId: activation.installation_id,
          targetPublicKeyFingerprint: targetFingerprint, tokenHash: hashSecret(grantToken, config.pepper),
          expiresAt: addSeconds(nowDate, 600), rollbackUntil: addSeconds(nowDate, 86400), now,
        });
        audit.recordLicenseEvent({
          licenseId: activation.license_id, eventType: 'product_migration.grant_issued', activationId,
          installationId: activation.installation_id, actorType: 'installation', actorId: activation.installation_id,
          metadata: { grant_id: grantId, target_public_key_fingerprint: targetFingerprint }, now,
        });
      });
      return {
        grantId, grantToken, targetInstallationId,
        expiresAt: addSeconds(nowDate, 600), rollbackUntil: addSeconds(nowDate, 86400),
      };
    },

    prepareProductMigration({
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
        invariant(sourceActivation && (!grant.source_activation_id || sourceActivation.id === grant.source_activation_id),
          'PRODUCT_MIGRATION_SOURCE_CHANGED', '源服务器激活所有权已经变化', 409);
        const build = repository.buildById(buildId);
        invariant(build && build.license_id === grant.license_id, 'BUILD_MISMATCH', '迁机凭证与当前安装包不匹配', 403);
        invariant(build.domain === normalizedDomain, 'DOMAIN_MISMATCH', '迁机域名与安装包不一致', 403);
        invariant(secretMatches(packageProof, build.package_secret_hash, config.pepper),
          'PACKAGE_PROOF_INVALID', '安装包身份校验失败', 403);
        invariant(installationFingerprint(installationPublicKey) === grant.target_public_key_fingerprint,
          'MIGRATION_TARGET_IDENTITY_MISMATCH', '新服务器安装身份与迁机凭证不一致', 403);
        invariant(!repository.installationIdentityById(installationId),
          'MIGRATION_TARGET_IDENTITY_EXISTS', '新服务器安装身份已经登记，必须生成新的安装身份', 409);
        const proof = consumeInstallationProof({
          purpose: 'migration_prepare',
          context: { grant_id: grant.id, build_id: buildId, domain: normalizedDomain, backend_origin: backendOrigin },
          installationId, publicKey: installationPublicKey, challengeId, signature: challengeSignature, now,
        });
        repository.registerInstallationIdentity({
          installationId: proof.installationId, licenseId: grant.license_id,
          publicKeyPem: proof.publicKey, publicKeyFingerprint: proof.fingerprint, status: 'candidate', now,
        });
        const refreshSecret = newRefreshSecret();
        const license = repository.licenseById(grant.license_id);
        const activation = repository.createActivation({
          id: newId('act'), licenseId: grant.license_id, buildId, domain: normalizedDomain,
          backendOrigin, installationId: proof.installationId, status: 'candidate', generation: license.generation,
          refreshSecretHash: hashSecret(refreshSecret, config.pepper), identityMode: 'server_key',
          installationPublicKeyFingerprint: proof.fingerprint, now,
        });
        invariant(repository.prepareProductMigrationGrant(grant.id, activation.id, now),
          'PRODUCT_MIGRATION_GRANT_RACE', '迁机凭证正在被另一个请求使用', 409);
        audit.recordLicenseEvent({
          licenseId: grant.license_id, eventType: 'product_migration.prepared', buildId,
          activationId: activation.id, installationId: proof.installationId,
          actorType: 'installation', actorId: proof.installationId,
          metadata: { grant_id: grant.id, source_installation_id: grant.source_installation_id }, now,
        });
        return {
          grantId: grant.id, activationId: activation.id, refreshSecret,
          rollbackUntil: grant.rollback_until, sourceStatus: 'active', targetStatus: 'candidate',
        };
      });
    },

    commitProductMigration({
      grantToken, installationId, installationPublicKey, challengeId, challengeSignature,
    }) {
      const nowDate = clock();
      const now = nowDate.toISOString();
      return transaction(database, () => {
        const grant = repository.productMigrationGrantByHash(hashSecret(grantToken, config.pepper));
        invariant(grant, 'PRODUCT_MIGRATION_GRANT_INVALID', '迁机凭证无效', 404);
        invariant(grant.status === 'prepared', 'PRODUCT_MIGRATION_NOT_PREPARED', '目标服务器尚未完成候选验证', 409);
        invariant(grant.rollback_until >= now, 'PRODUCT_MIGRATION_ROLLBACK_EXPIRED', '迁机切换窗口已过期', 409);
        const targetActivation = repository.activationById(grant.target_activation_id);
        invariant(targetActivation?.status === 'candidate', 'PRODUCT_MIGRATION_TARGET_CHANGED', '目标候选激活状态已经变化', 409);
        invariant(targetActivation.installation_id === installationId,
          'MIGRATION_TARGET_IDENTITY_MISMATCH', '目标安装身份与候选激活不一致', 403);
        invariant(installationFingerprint(installationPublicKey) === grant.target_public_key_fingerprint,
          'MIGRATION_TARGET_IDENTITY_MISMATCH', '目标安装公钥与迁机凭证不一致', 403);
        const sourceActivation = repository.activeActivationByInstallation(grant.license_id, grant.source_installation_id);
        invariant(sourceActivation && (!grant.source_activation_id || sourceActivation.id === grant.source_activation_id),
          'PRODUCT_MIGRATION_SOURCE_CHANGED', '源服务器激活所有权已经变化', 409);
        consumeInstallationProof({
          purpose: 'migration_commit', context: { grant_id: grant.id, target_activation_id: targetActivation.id },
          installationId, publicKey: installationPublicKey, challengeId, signature: challengeSignature, now,
        });
        invariant(repository.completeProductMigrationGrant(grant.id, now),
          'PRODUCT_MIGRATION_COMMIT_RACE', '迁机正在被另一个请求切换', 409);
        invariant(repository.fenceActivationsByInstallation(grant.license_id, grant.source_installation_id, now) > 0,
          'PRODUCT_MIGRATION_SOURCE_CHANGED', '源服务器激活所有权已经变化', 409);
        invariant(repository.fenceInstallationIdentity(grant.source_installation_id, now),
          'PRODUCT_MIGRATION_SOURCE_CHANGED', '源服务器安装身份已经变化', 409);
        invariant(repository.transitionActivationStatus(targetActivation.id, 'candidate', 'active', now),
          'PRODUCT_MIGRATION_TARGET_CHANGED', '目标候选激活状态已经变化', 409);
        invariant(repository.activateInstallationIdentity(installationId, now),
          'PRODUCT_MIGRATION_TARGET_CHANGED', '目标安装身份状态已经变化', 409);
        const activeTarget = repository.activationById(targetActivation.id);
        audit.recordLicenseEvent({
          licenseId: grant.license_id, eventType: 'product_migration.completed', buildId: activeTarget.build_id,
          activationId: activeTarget.id, installationId,
          actorType: 'installation', actorId: installationId,
          metadata: { grant_id: grant.id, source_installation_id: grant.source_installation_id }, now,
        });
        return {
          activationId: activeTarget.id,
          token: signCompactToken(activationPayload(activeTarget, nowDate), activationPrivateKey),
          expiresAt: addSeconds(nowDate, config.activationTokenTtlSeconds),
          rollbackUntil: grant.rollback_until, sourceStatus: 'fenced', targetStatus: 'active',
        };
      });
    },

    rollbackProductMigration({
      grantToken, refreshSecret = null, reason = 'health_check_failed',
      installationId, installationPublicKey, challengeId, challengeSignature,
    }) {
      const nowDate = clock();
      const now = nowDate.toISOString();
      return transaction(database, () => {
        const grant = repository.productMigrationGrantByHash(hashSecret(grantToken, config.pepper));
        invariant(grant, 'PRODUCT_MIGRATION_GRANT_INVALID', '迁机凭证无效', 404);
        invariant(['prepared', 'completed'].includes(grant.status),
          'PRODUCT_MIGRATION_NOT_ROLLBACKABLE', '当前迁机状态不能回滚', 409);
        invariant(grant.rollback_until >= now, 'PRODUCT_MIGRATION_ROLLBACK_EXPIRED', '迁机回滚窗口已过期', 409);
        const targetActivation = repository.activationById(grant.target_activation_id);
        invariant(targetActivation, 'PRODUCT_MIGRATION_TARGET_CHANGED', '目标迁机激活不存在', 409);
        if (grant.status === 'prepared') {
          invariant(targetActivation.status === 'candidate' && targetActivation.installation_id === installationId,
            'PRODUCT_MIGRATION_TARGET_CHANGED', '目标候选激活状态已经变化', 409);
          invariant(installationFingerprint(installationPublicKey) === grant.target_public_key_fingerprint,
            'MIGRATION_TARGET_IDENTITY_MISMATCH', '目标安装公钥与迁机凭证不一致', 403);
          consumeInstallationProof({
            purpose: 'migration_rollback', context: { grant_id: grant.id, phase: 'prepared' },
            installationId, publicKey: installationPublicKey, challengeId, signature: challengeSignature, now,
          });
          invariant(repository.transitionActivationStatus(targetActivation.id, 'candidate', 'revoked', now),
            'PRODUCT_MIGRATION_TARGET_CHANGED', '目标候选激活状态已经变化', 409);
          repository.revokeInstallationIdentity(installationId, now);
        } else {
          const sourceActivation = repository.activationById(grant.source_activation_id);
          invariant(sourceActivation?.status === 'fenced' && sourceActivation.installation_id === installationId,
            'PRODUCT_MIGRATION_SOURCE_CHANGED', '源服务器已不具备回滚资格', 409);
          invariant(secretMatches(refreshSecret, sourceActivation.refresh_secret_hash, config.pepper),
            'REFRESH_SECRET_INVALID', '源服务器刷新凭证无效', 401);
          const sourceIdentity = repository.installationIdentityById(installationId);
          invariant(sourceIdentity?.status === 'fenced', 'PRODUCT_MIGRATION_SOURCE_CHANGED', '源服务器安装身份状态已经变化', 409);
          consumeInstallationProof({
            purpose: 'migration_rollback', context: { grant_id: grant.id, phase: 'completed' },
            installationId, publicKey: installationPublicKey, challengeId, signature: challengeSignature, now,
          });
          invariant(repository.transitionActivationStatus(targetActivation.id, 'active', 'fenced', now),
            'PRODUCT_MIGRATION_TARGET_CHANGED', '目标服务器激活状态已经变化', 409);
          repository.fenceInstallationIdentity(targetActivation.installation_id, now);
          invariant(repository.transitionActivationStatus(sourceActivation.id, 'fenced', 'active', now),
            'PRODUCT_MIGRATION_SOURCE_CHANGED', '源服务器激活状态已经变化', 409);
          invariant(repository.activateInstallationIdentity(installationId, now),
            'PRODUCT_MIGRATION_SOURCE_CHANGED', '源服务器安装身份状态已经变化', 409);
        }
        invariant(repository.rollbackProductMigrationGrant(grant.id, String(reason ?? '').slice(0, 500), now),
          'PRODUCT_MIGRATION_ROLLBACK_RACE', '迁机正在被另一个请求回滚', 409);
        const restored = grant.status === 'completed' ? repository.activationById(grant.source_activation_id) : null;
        audit.recordLicenseEvent({
          licenseId: grant.license_id, eventType: 'product_migration.rolled_back',
          activationId: restored?.id ?? targetActivation.id,
          installationId, actorType: 'installation', actorId: installationId,
          metadata: { grant_id: grant.id, previous_status: grant.status, reason }, now,
        });
        return {
          rolledBack: true, sourceStatus: 'active', targetStatus: grant.status === 'prepared' ? 'revoked' : 'fenced',
          activationId: restored?.id ?? null,
          token: restored ? signCompactToken(activationPayload(restored, nowDate), activationPrivateKey) : null,
          expiresAt: restored ? addSeconds(nowDate, config.activationTokenTtlSeconds) : null,
        };
      });
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
        invariant(installationFingerprint(installationPublicKey) === grant.target_public_key_fingerprint,
          'MIGRATION_TARGET_IDENTITY_MISMATCH', '新服务器安装身份与迁机凭证不一致', 403);
        const proof = consumeInstallationProof({
          purpose: 'migration_accept',
          context: { grant_id: grant.id, build_id: buildId, domain: normalizedDomain, backend_origin: backendOrigin },
          installationId, publicKey: installationPublicKey, challengeId, signature: challengeSignature, now,
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
          id: newId('act'), licenseId: grant.license_id, buildId, domain: normalizedDomain,
          backendOrigin, installationId: proof.installationId, generation: license.generation,
          refreshSecretHash: hashSecret(refreshSecret, config.pepper), identityMode: 'server_key',
          installationPublicKeyFingerprint: proof.fingerprint, now,
        });
        audit.recordLicenseEvent({
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
  });
}

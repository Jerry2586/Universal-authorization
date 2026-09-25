import { transaction } from '../../database.js';
import { createHash } from 'node:crypto';
import { canonicalizeDomain } from '../../../../../packages/core/src/canonicalize.js';
import { invariant } from '../../../../../packages/core/src/errors.js';
import { newId } from '../../../../../packages/core/src/identifiers.js';
import { openSecret, sealSecret } from '../../../../../packages/core/src/secret-box.js';
import { secretMatches } from '../../../../../packages/core/src/security.js';
import { publicBuildJob, SOURCE_KIND } from '../../../../../packages/contracts/src/build-job.js';

export function createPackagingService({
  database, repository, queue, buildAuthorization, entitlementAccess, operations, artifactStore, buildEngine, config, clock = () => new Date(),
}) {
  function customerLicense(session) {
    const license = repository.licenseById(session.actor_id);
    invariant(license && license.status === 'active', 'LICENSE_INACTIVE', '授权已停用', 403);
    return license;
  }

  function recoverExpiredBuilds() {
    const now = clock().toISOString();
    transaction(database, () => {
      for (const job of repository.expiredBuildJobs(now)) {
        repository.failBuildJob({ id: job.id, workerId: job.lease_owner, errorCode: 'BUILD_LEASE_EXPIRED',
          message: '构建节点失联或超时，可重新构建', now });
        repository.audit({ actorType: 'system', actorId: 'build-queue', action: 'build_job.lease_expired',
          subjectType: 'build_job', subjectId: job.id, metadata: {}, now });
      }
    });
  }

  function cleanupCancelledArtifacts() {
    // The cancelled job retains its reference until removal succeeds: retryable outbox.
    for (const job of repository.cancelledArtifacts()) {
      try {
        artifactStore.remove(job.artifact_ref);
        repository.clearCancelledArtifact(job.id);
      } catch { /* Keep the reference for the next Worker poll or void request. */ }
    }
  }

  return Object.freeze({
    enqueueCustomerBuild(session, { version, domain, intent = 'install', base_version = null }) {
      const license = customerLicense(session);
      const normalizedDomain = canonicalizeDomain(domain || license.bound_domain);
      invariant(license.bound_domain === normalizedDomain, 'LICENSE_DOMAIN_MISMATCH', '只能为固定 Key 当前绑定域名打包', 403);
      const sourceVersion = repository.sourceVersionByProductVersion(license.product_code, version);
      invariant(sourceVersion && sourceVersion.status === 'active', 'SOURCE_VERSION_NOT_READY', '该 APPGOG 版本尚未接入安全构建 Worker', 409);
      entitlementAccess.assertVersionAccess({ license, source: sourceVersion });
      invariant(['install', 'update', 'reinstall'].includes(intent), 'BUILD_INTENT_INVALID', '构建类型无效');
      invariant(base_version === null || typeof base_version === 'string' && base_version.length <= 128, 'BUILD_BASE_VERSION_INVALID', '原版本号无效');
      const versions = repository.listActiveSourceVersions(license.product_code);
      const currentVersion = repository.activeActivationByLicense(license.id)?.version ?? null;
      if (intent !== 'install' && currentVersion) {
        invariant(base_version === null || base_version === currentVersion, 'BUILD_BASE_VERSION_STALE', '当前安装版本已变化，请刷新后重新构建', 409);
        base_version = currentVersion;
      }
      const latestEligibleVersion = versions.find((item) => entitlementAccess.versionEligibility({ license, source: item }).eligible)?.version ?? null;
      invariant(sourceVersion.version === latestEligibleVersion || sourceVersion.version === currentVersion,
        'HISTORICAL_BUILD_DISABLED', '历史版本不再提供客户构建；请选择最新版本或重新构建当前版本', 409);
      if (license.update_until) {
        invariant(new Date(sourceVersion.published_at ?? sourceVersion.created_at) <= new Date(license.update_until),
          'UPDATE_WINDOW_EXPIRED', '该版本发布时间已超出更新服务期限', 403);
      }
      recoverExpiredBuilds();
      const now = clock().toISOString();
      return transaction(database, () => {
        const existing = repository.reusableBuildJob(license.id, sourceVersion.id, normalizedDomain, intent, base_version, now);
        if (existing) return { ...publicBuildJob(existing), reused: true };
        const job = queue.enqueue({
          id: newId('job'), licenseId: license.id, sourceVersionId: sourceVersion.id,
          version: sourceVersion.version, domain: normalizedDomain, intent, baseVersion: base_version,
          sourceKind: SOURCE_KIND.OFFICIAL, message: '任务已进入安全构建队列', now,
        });
        repository.audit({
          actorType: 'customer', actorId: license.id, action: 'build_job.created',
          subjectType: 'build_job', subjectId: job.id,
          metadata: { version: job.requested_version, domain: job.requested_domain, intent }, now,
        });
        return publicBuildJob(job);
      });
    },

    buildDetails(session, jobId) {
      customerLicense(session);
      const job = repository.buildJobById(jobId);
      invariant(job && job.license_id === session.actor_id, 'BUILD_JOB_NOT_FOUND', '构建任务不存在', 404);
      const build = job.build_id && repository.buildById(job.build_id);
      const key = job.build_id && repository.installKeyByBuildId(job.build_id);
      const available = build?.status === 'ready' && key?.status === 'available'
        && (!key.expires_at || key.expires_at > clock().toISOString());
      return {
        ...publicBuildJob(job),
        can_void: job.status === 'queued' || job.status === 'succeeded' && build?.status === 'ready' && key?.status === 'available',
        install_key: job.status === 'succeeded' && available && job.install_key_encrypted
          ? openSecret(job.install_key_encrypted, config.deliveryEncryptionKey)
          : null,
        artifact_sha256: job.artifact_sha256,
      };
    },

    artifactForDownload(session, jobId) {
      customerLicense(session);
      const job = repository.buildJobById(jobId);
      invariant(job && job.license_id === session.actor_id, 'BUILD_JOB_NOT_FOUND', '构建任务不存在', 404);
      invariant(job.status === 'succeeded' && job.artifact_ref, 'ARTIFACT_NOT_READY', '构建成品尚未生成', 409);
      const build = repository.buildById(job.build_id);
      const installKey = repository.installKeyByBuildId(job.build_id);
      invariant(build?.status === 'ready' && installKey?.status === 'available'
        && (!installKey.expires_at || installKey.expires_at > clock().toISOString()),
        'ARTIFACT_NO_LONGER_AVAILABLE', '此包已使用、失效或作废，请重新构建', 409);
      return {
        key: job.artifact_ref,
        filename: `APPGOG-${job.requested_version}-${job.build_id.slice(-10)}.zip`,
        sha256: job.artifact_sha256,
      };
    },

    voidCustomerBuild(session, jobId) {
      customerLicense(session);
      const result = transaction(database, () => {
        const job = repository.buildJobById(jobId);
        invariant(job && job.license_id === session.actor_id, 'BUILD_JOB_NOT_FOUND', '构建任务不存在', 404);
        if (job.status === 'cancelled') return publicBuildJob(job);
        invariant(['queued', 'succeeded'].includes(job.status), 'BUILD_CANNOT_VOID', '正在构建的任务不能作废，请等待构建结束', 409);
        if (job.build_id) {
          const build = repository.buildById(job.build_id);
          const key = repository.installKeyByBuildId(job.build_id);
          invariant(build?.status === 'ready' && key?.status === 'available', 'BUILD_ALREADY_USED', '已解锁或激活的安装包不能作废', 409);
          repository.revokeUnactivatedBuild(job.build_id);
        }
        const now = clock().toISOString();
        invariant(repository.cancelBuildJob(job.id, now), 'BUILD_STATE_CHANGED', '任务状态已变化，请刷新', 409);
        repository.audit({ actorType: 'customer', actorId: session.actor_id, action: 'build_job.voided',
          subjectType: 'build_job', subjectId: job.id, metadata: { build_id: job.build_id }, now });
        return publicBuildJob(repository.buildJobById(job.id));
      });
      cleanupCancelledArtifacts();
      return result;
    },

    leaseBuild(workerId) {
      recoverExpiredBuilds();
      cleanupCancelledArtifacts();
      const job = queue.leaseNext(workerId, 300);
      if (!job) return null;
      let claimedBuild;
      try {
        claimedBuild = buildAuthorization.claimBuildForJob({
          licenseId: job.license_id, version: job.requested_version, domain: job.requested_domain,
        });
        invariant(repository.assignBuildToJob(job.id, workerId, claimedBuild.buildId), 'BUILD_LEASE_INVALID', '构建任务租约失效', 409);
        return {
          job: publicBuildJob(job),
          source: repository.sourceVersionById(job.source_version_id),
          build: { ...claimedBuild, licenseServer: operations.cmsSettings().license_public_url },
        };
      } catch (error) {
        if (claimedBuild) repository.revokeUnactivatedBuild(claimedBuild.buildId);
        queue.fail(job.id, { workerId, code: error.code ?? 'BUILD_AUTHORIZATION_FAILED', message: error.message });
        throw error;
      }
    },

    sourceForWorker(workerId, jobId) {
      const job = repository.buildJobById(jobId);
      invariant(job && job.status === 'processing' && job.lease_owner === workerId, 'BUILD_LEASE_INVALID', '构建任务租约无效', 409);
      const source = repository.sourceVersionById(job.source_version_id);
      invariant(source?.source_ref, 'SOURCE_VERSION_NOT_READY', '构建源码不存在', 409);
      return artifactStore.read(source.source_ref);
    },

    saveWorkerArtifact(workerId, jobId, buffer) {
      const job = repository.buildJobById(jobId);
      invariant(job && job.status === 'processing' && job.lease_owner === workerId, 'BUILD_LEASE_INVALID', '构建任务租约无效', 409);
      buildEngine.validateSource(buffer);
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      const artifactRef = `builds/${job.id}/worker-upload-${sha256.slice(0, 12)}.zip`;
      artifactStore.put(artifactRef, buffer);
      return { artifact_ref: artifactRef, artifact_sha256: sha256 };
    },

    updateBuildProgress(workerId, jobId, { progress, message }) {
      invariant(queue.progress(jobId, workerId, progress, message), 'BUILD_LEASE_INVALID', '构建任务租约无效', 409);
      return publicBuildJob(repository.buildJobById(jobId));
    },

    completeBuild(workerId, jobId, result) {
      const job = repository.buildJobById(jobId);
      const build = repository.buildById(result.build_id);
      invariant(job && job.status === 'processing' && job.lease_owner === workerId, 'BUILD_LEASE_INVALID', '构建任务租约无效', 409);
      invariant(
        build && build.license_id === job.license_id && build.version === job.requested_version && build.domain === job.requested_domain,
        'BUILD_RESULT_MISMATCH', 'Worker 返回的构建身份与任务不一致', 409,
      );
      invariant(/^[a-f0-9]{64}$/i.test(result.artifact_sha256 ?? ''), 'ARTIFACT_HASH_INVALID', '构建成品 SHA-256 无效');
      invariant(typeof result.artifact_ref === 'string' && result.artifact_ref.length > 0, 'ARTIFACT_REF_INVALID', '构建成品引用无效');
      let artifactBuffer;
      try { artifactBuffer = artifactStore.read(result.artifact_ref); }
      catch { throw new Error('ARTIFACT_NOT_FOUND'); }
      const actualHash = createHash('sha256').update(artifactBuffer).digest('hex');
      invariant(actualHash === result.artifact_sha256.toLowerCase(), 'ARTIFACT_HASH_MISMATCH', '构建成品哈希与实际文件不一致', 409);
      invariant(secretMatches(result.package_proof, build.package_secret_hash, config.pepper),
        'PACKAGE_PROOF_INVALID', 'Worker 返回的 Package Secret 与构建身份不匹配', 409);
      const watermark = createHash('sha256').update(`${build.license_id}:${build.id}:${build.package_id}`).digest('hex');
      buildEngine.verifyArtifact({
        buffer: artifactBuffer,
        packageSecret: result.package_proof,
        expected: {
          issuer: config.publicBaseUrl, product: build.product_code, version: build.version,
          build_id: build.id, package_id: build.package_id, domain: build.domain, watermark,
        },
      });
      const installKeyRecord = repository.installKeyByBuildId(build.id);
      invariant(installKeyRecord && secretMatches(result.install_key, installKeyRecord.key_hash, config.pepper),
        'INSTALL_KEY_MISMATCH', 'Worker 安装 Key 与构建身份不匹配', 409);
      const completed = queue.complete(jobId, {
        workerId, buildId: result.build_id, artifactRef: result.artifact_ref,
        artifactSha256: result.artifact_sha256,
        installKeyEncrypted: sealSecret(result.install_key, config.deliveryEncryptionKey),
        message: '构建完成，可以下载安装',
      });
      invariant(completed, 'BUILD_LEASE_INVALID', '构建任务租约无效', 409);
      return publicBuildJob(completed);
    },

    failBuild(workerId, jobId, error) {
      const failed = queue.fail(jobId, { workerId, code: error.code, message: error.message });
      invariant(failed, 'BUILD_LEASE_INVALID', '构建任务租约无效', 409);
      return publicBuildJob(failed);
    },
  });
}

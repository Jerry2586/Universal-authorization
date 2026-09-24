import { createHash } from 'node:crypto';
import { canonicalizeDomain } from '../../../../../packages/core/src/canonicalize.js';
import { invariant } from '../../../../../packages/core/src/errors.js';
import { newId } from '../../../../../packages/core/src/identifiers.js';
import { openSecret, sealSecret } from '../../../../../packages/core/src/secret-box.js';
import { secretMatches } from '../../../../../packages/core/src/security.js';
import { publicBuildJob, SOURCE_KIND } from '../../../../../packages/contracts/src/build-job.js';

export function createPackagingService({
  repository, queue, buildAuthorization, operations, artifactStore, buildEngine, config, clock = () => new Date(),
}) {
  function customerLicense(session) {
    const license = repository.licenseById(session.actor_id);
    invariant(license && license.status === 'active', 'LICENSE_INACTIVE', '授权已停用', 403);
    return license;
  }

  return Object.freeze({
    enqueueCustomerBuild(session, { version, domain, intent = 'install', base_version = null }) {
      const license = customerLicense(session);
      const normalizedDomain = canonicalizeDomain(domain || license.bound_domain);
      invariant(license.bound_domain === normalizedDomain, 'LICENSE_DOMAIN_MISMATCH', '只能为固定 Key 当前绑定域名打包', 403);
      const sourceVersion = repository.sourceVersionByProductVersion(license.product_code, version);
      invariant(sourceVersion && sourceVersion.status === 'active', 'SOURCE_VERSION_NOT_READY', '该 APPGOG 版本尚未接入安全构建 Worker', 409);
      invariant(['install', 'update', 'reinstall'].includes(intent), 'BUILD_INTENT_INVALID', '构建类型无效');
      const versions = repository.listActiveSourceVersions(license.product_code);
      const currentVersion = repository.activeActivationByLicense(license.id)?.version ?? null;
      invariant(sourceVersion.version === versions[0]?.version || sourceVersion.version === currentVersion,
        'HISTORICAL_BUILD_DISABLED', '历史版本不再提供客户构建；请选择最新版本或重新构建当前版本', 409);
      if (license.update_until) {
        invariant(new Date(sourceVersion.published_at ?? sourceVersion.created_at) <= new Date(license.update_until),
          'UPDATE_WINDOW_EXPIRED', '该版本发布时间已超出更新服务期限', 403);
      }
      const now = clock().toISOString();
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
    },

    buildDetails(session, jobId) {
      const job = repository.buildJobById(jobId);
      invariant(job && job.license_id === session.actor_id, 'BUILD_JOB_NOT_FOUND', '构建任务不存在', 404);
      return {
        ...publicBuildJob(job),
        install_key: job.status === 'succeeded' && job.install_key_encrypted
          ? openSecret(job.install_key_encrypted, config.deliveryEncryptionKey)
          : null,
        artifact_sha256: job.artifact_sha256,
      };
    },

    artifactForDownload(session, jobId) {
      const job = repository.buildJobById(jobId);
      invariant(job && job.license_id === session.actor_id, 'BUILD_JOB_NOT_FOUND', '构建任务不存在', 404);
      invariant(job.status === 'succeeded' && job.artifact_ref, 'ARTIFACT_NOT_READY', '构建成品尚未生成', 409);
      return {
        key: job.artifact_ref,
        filename: `APPGOG-${job.requested_version}-${job.build_id.slice(-10)}.zip`,
        sha256: job.artifact_sha256,
      };
    },

    leaseBuild(workerId) {
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

import { createHash } from 'node:crypto';
import { canonicalizeDomain } from '../../../packages/core/src/canonicalize.js';
import { invariant } from '../../../packages/core/src/errors.js';
import { newId } from '../../../packages/core/src/identifiers.js';
import { openSecret, sealSecret } from '../../../packages/core/src/secret-box.js';
import { secretMatches } from '../../../packages/core/src/security.js';
import { publicBuildJob, SOURCE_KIND } from '../../../packages/contracts/src/build-job.js';

export function createPortalService({ repository, queue, licenseService, artifactStore, buildEngine, config, clock = () => new Date() }) {
  function customerLicense(session) {
    const license = repository.licenseById(session.actor_id);
    invariant(license && license.status === 'active', 'LICENSE_INACTIVE', '授权已停用', 403);
    return license;
  }

  return {
    repository,
    customerOverview(session) {
      const license = customerLicense(session);
      const builds = repository.listBuildJobsByLicense(license.id, 30);
      const currentVersion = repository.activeActivationByLicense(license.id)?.version ?? null;
      const versions = repository.listActiveSourceVersions(license.product_code);
      const latestVersion = versions[0]?.version ?? null;
      return {
        license: {
          product: license.product_code,
          key_prefix: license.key_prefix,
          status: license.status,
          bound_domain: license.bound_domain,
          update_until: license.update_until,
          max_builds_per_day: license.max_builds_per_day,
          generation: license.generation,
        },
        versions: versions.map((version) => ({
          version: version.version,
          display_name: version.display_name,
          source_kind: version.source_kind,
          release_notes: version.release_notes,
          channel: version.channel,
          release_kind: version.release_kind,
          min_xboard_version: version.min_xboard_version,
          min_upgrade_version: version.min_upgrade_version,
          rollback_allowed: Boolean(version.rollback_allowed),
          rollback_to: version.rollback_to,
          published_at: version.published_at ?? version.created_at,
          is_latest: version.version === latestVersion,
          is_current: version.version === currentVersion,
          eligible: !license.update_until || new Date(version.published_at ?? version.created_at) <= new Date(license.update_until),
        })),
        current_version: currentVersion,
        latest_version: latestVersion,
        builds: builds.map(publicBuildJob),
      };
    },

    enqueueCustomerBuild(session, { version, domain, intent = 'install', base_version = null }) {
      const license = customerLicense(session);
      const normalizedDomain = canonicalizeDomain(domain || license.bound_domain);
      invariant(license.bound_domain === normalizedDomain, 'LICENSE_DOMAIN_MISMATCH', '只能为固定 Key 当前绑定域名打包', 403);
      const sourceVersion = repository.sourceVersionByProductVersion(license.product_code, version);
      invariant(sourceVersion && sourceVersion.status === 'active', 'SOURCE_VERSION_NOT_READY', '该 APPGOG 版本尚未接入安全构建 Worker', 409);
      invariant(['install', 'update', 'rollback', 'reinstall'].includes(intent), 'BUILD_INTENT_INVALID', '构建类型无效');
      if (license.update_until) invariant(new Date(sourceVersion.published_at ?? sourceVersion.created_at) <= new Date(license.update_until), 'UPDATE_WINDOW_EXPIRED', '该版本发布时间已超出更新服务期限', 403);
      if (intent === 'rollback') invariant(Boolean(sourceVersion.rollback_allowed), 'ROLLBACK_NOT_ALLOWED', '该版本不允许生成回滚包', 409);
      const now = clock().toISOString();
      const job = queue.enqueue({
        id: newId('job'),
        licenseId: license.id,
        sourceVersionId: sourceVersion.id,
        version: sourceVersion.version,
        domain: normalizedDomain,
        intent,
        baseVersion: base_version,
        sourceKind: SOURCE_KIND.OFFICIAL,
        message: '任务已进入安全构建队列',
        now,
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

    registerSourceVersion({ productCode = 'appgog', version, displayName, releaseNotes, channel, releaseKind, minXboardVersion, minUpgradeVersion, rollbackAllowed, rollbackTo }) {
      invariant(version?.trim(), 'VERSION_REQUIRED', '必须填写版本号');
      const product = licenseService.ensureProduct({ code: productCode, name: productCode.toUpperCase() });
      invariant(!repository.sourceVersionByProductVersion(product.code, version.trim()), 'VERSION_EXISTS', '该版本已经存在', 409);
      return repository.createSourceVersion({
        productId: product.id,
        version: version.trim(),
        displayName: displayName?.trim() || `APPGOG ${version.trim()}`,
        sourceKind: SOURCE_KIND.OFFICIAL,
        sourceRef: null,
        status: 'draft',
        releaseNotes, channel, releaseKind, minXboardVersion, minUpgradeVersion, rollbackAllowed, rollbackTo,
        now: clock().toISOString(),
      });
    },

    publishSourceVersion({ productCode = 'appgog', version, displayName, zipBuffer, releaseNotes, channel, releaseKind, minXboardVersion, minUpgradeVersion, rollbackAllowed, rollbackTo, actorId = null }) {
      invariant(Buffer.isBuffer(zipBuffer) && zipBuffer.length > 0, 'SOURCE_REQUIRED', '必须上传主题 ZIP');
      invariant(zipBuffer.length <= config.maxSourceUploadBytes, 'SOURCE_TOO_LARGE', '上传的主题 ZIP 超出大小限制', 413);
      buildEngine.validateSource(zipBuffer);
      const product = licenseService.ensureProduct({ code: productCode, name: productCode.toUpperCase() });
      const normalizedVersion = version?.trim();
      invariant(normalizedVersion, 'VERSION_REQUIRED', '必须填写版本号');
      const existing = repository.sourceVersionByProductVersion(product.code, normalizedVersion);
      invariant(!existing || existing.status === 'draft', 'VERSION_EXISTS', '该版本已经发布', 409);
      const versionId = existing?.id ?? newId('src');
      const safeVersion = normalizedVersion.replace(/[^a-zA-Z0-9._-]/g, '_');
      const sourceRef = `sources/${product.code}/${safeVersion}/${versionId}.zip`;
      artifactStore.put(sourceRef, zipBuffer);
      try {
        const values = {
          id: versionId,
          productId: product.id,
          version: normalizedVersion,
          displayName: displayName?.trim() || `APPGOG ${normalizedVersion}`,
          sourceKind: SOURCE_KIND.OFFICIAL,
          sourceRef,
          status: 'active',
          releaseNotes, channel, releaseKind, minXboardVersion, minUpgradeVersion, rollbackAllowed, rollbackTo,
          now: clock().toISOString(),
        };
        const source = existing
          ? repository.publishSourceVersion(values)
          : repository.createSourceVersion(values);
        invariant(source, 'VERSION_PUBLISH_CONFLICT', '版本状态已发生变化，请刷新后重试', 409);
        repository.audit({
          actorType: 'admin', actorId, action: 'source_version.published',
          subjectType: 'source_version', subjectId: source.id,
          metadata: { version: source.version, source_ref: sourceRef, size: zipBuffer.length },
          now: clock().toISOString(),
        });
        return source;
      } catch (error) {
        artifactStore.remove(sourceRef);
        throw error;
      }
    },

    adminOverview() {
      const start = new Date(clock());
      start.setHours(0, 0, 0, 0);
      return {
        stats: repository.dashboardStats(start.toISOString()),
        licenses: repository.listLicenses(100).map((license) => ({
          id: license.id,
          product: license.product_code,
          customer_ref: license.customer_ref,
          key_prefix: license.key_prefix,
          status: license.status,
          bound_domain: license.bound_domain,
          update_until: license.update_until,
          max_builds_per_day: license.max_builds_per_day,
          generation: license.generation,
          build_count: license.build_count,
          active_activation_count: license.active_activation_count,
          created_at: license.created_at,
        })),
        builds: repository.listBuildJobs(100).map(publicBuildJob),
        activations: repository.listActivations(100).map((activation) => ({
          id: activation.id,
          customer_ref: activation.customer_ref,
          product: activation.product_code,
          version: activation.version,
          domain: activation.domain,
          backend_origin: activation.backend_origin,
          installation_id: activation.installation_id,
          status: activation.status,
          last_seen_at: activation.last_seen_at,
          created_at: activation.created_at,
        })),
        audit: repository.listAudit(100),
        versions: repository.listSourceVersions('appgog').map((version) => ({
          id: version.id,
          version: version.version,
          display_name: version.display_name,
          status: version.status,
          source_kind: version.source_kind,
          release_notes: version.release_notes,
          channel: version.channel,
          release_kind: version.release_kind,
          min_xboard_version: version.min_xboard_version,
          min_upgrade_version: version.min_upgrade_version,
          rollback_allowed: Boolean(version.rollback_allowed),
          rollback_to: version.rollback_to,
          withdrawn_reason: version.withdrawn_reason,
          published_at: version.published_at,
          created_at: version.created_at,
        })),
        admins: repository.listAdmins().map((admin) => ({
          id: admin.id, username: admin.username, display_name: admin.display_name, role: admin.role,
          status: admin.status, is_owner: Boolean(admin.is_owner), last_login_at: admin.last_login_at,
          last_login_ip: admin.last_login_ip, created_at: admin.created_at,
        })),
      };
    },

    withdrawSourceVersion({ id, reason, actorId }) {
      invariant(typeof reason === 'string' && reason.trim().length >= 8, 'WITHDRAW_REASON_REQUIRED', '撤回原因至少 8 个字');
      const version = repository.withdrawSourceVersion(id, reason.trim());
      invariant(version, 'VERSION_WITHDRAW_CONFLICT', '版本不存在或不是已发布状态', 409);
      repository.audit({ actorType: 'admin', actorId, action: 'source_version.withdrawn', subjectType: 'source_version', subjectId: id,
        metadata: { version: version.version, reason: reason.trim() }, now: clock().toISOString() });
      return version;
    },

    leaseBuild(workerId) {
      const job = queue.leaseNext(workerId, 300);
      if (!job) return null;
      let claimedBuild;
      try {
        claimedBuild = licenseService.claimBuildForJob({
          licenseId: job.license_id,
          version: job.requested_version,
          domain: job.requested_domain,
        });
        invariant(repository.assignBuildToJob(job.id, workerId, claimedBuild.buildId), 'BUILD_LEASE_INVALID', '构建任务租约失效', 409);
        return {
          job: publicBuildJob(job),
          source: repository.sourceVersionById(job.source_version_id),
          build: claimedBuild,
        };
      } catch (error) {
        if (claimedBuild) repository.revokeUnactivatedBuild(claimedBuild.buildId);
        queue.fail(job.id, { workerId, code: error.code ?? 'BUILD_AUTHORIZATION_FAILED', message: error.message });
        throw error;
      }
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
        'BUILD_RESULT_MISMATCH',
        'Worker 返回的构建身份与任务不一致',
        409,
      );
      invariant(/^[a-f0-9]{64}$/i.test(result.artifact_sha256 ?? ''), 'ARTIFACT_HASH_INVALID', '构建成品 SHA-256 无效');
      invariant(typeof result.artifact_ref === 'string' && result.artifact_ref.length > 0, 'ARTIFACT_REF_INVALID', '构建成品引用无效');
      let artifactBuffer;
      try {
        artifactBuffer = artifactStore.read(result.artifact_ref);
      } catch {
        throw new Error('ARTIFACT_NOT_FOUND');
      }
      const actualHash = createHash('sha256').update(artifactBuffer).digest('hex');
      invariant(actualHash === result.artifact_sha256.toLowerCase(), 'ARTIFACT_HASH_MISMATCH', '构建成品哈希与实际文件不一致', 409);
      buildEngine.validateSource(artifactBuffer);
      const installKeyRecord = repository.installKeyByBuildId(build.id);
      invariant(installKeyRecord && secretMatches(result.install_key, installKeyRecord.key_hash, config.pepper), 'INSTALL_KEY_MISMATCH', 'Worker 安装 Key 与构建身份不匹配', 409);
      const completed = queue.complete(jobId, {
        workerId,
        buildId: result.build_id,
        artifactRef: result.artifact_ref,
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
  };
}

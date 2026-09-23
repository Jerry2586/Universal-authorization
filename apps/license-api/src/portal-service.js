import { createHash } from 'node:crypto';
import { canonicalizeDomain } from '../../../packages/core/src/canonicalize.js';
import { invariant } from '../../../packages/core/src/errors.js';
import { keyPrefix, newId, newNodeCredential } from '../../../packages/core/src/identifiers.js';
import { openSecret, sealSecret } from '../../../packages/core/src/secret-box.js';
import { hashSecret, secretMatches } from '../../../packages/core/src/security.js';
import { publicBuildJob, SOURCE_KIND } from '../../../packages/contracts/src/build-job.js';

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function versionFromName(value) {
  const text = String(value ?? '').replace(/\.zip$/i, '');
  if (!/appgog/i.test(text)) return null;
  return text.match(/(?:^|[-_\s])v?(\d+\.\d+\.\d+)(?:$|[-_\s])/i)?.[1] ?? null;
}

function sourceMetadata(files, sourceFilename) {
  const configPaths = [...files.keys()]
    .filter((name) => name.split('/').at(-1)?.toLowerCase() === 'config.json')
    .sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right));
  let config = {};
  if (configPaths.length) {
    try { config = JSON.parse(files.get(configPaths[0]).toString('utf8')); }
    catch { invariant(false, 'SOURCE_CONFIG_INVALID', '主题 config.json 不是有效 JSON', 400); }
  }
  const configVersion = [config.version, config.theme?.version, config.appgog?.version]
    .find((value) => typeof value === 'string' && VERSION_PATTERN.test(value.trim()))?.trim() ?? null;
  const roots = [...new Set([...files.keys()].map((name) => name.split('/')[0]).filter(Boolean))];
  const nameVersions = [sourceFilename, ...roots].map(versionFromName).filter(Boolean);
  const uniqueNameVersions = [...new Set(nameVersions)];
  invariant(uniqueNameVersions.length <= 1, 'SOURCE_VERSION_CONFLICT', 'ZIP 文件名与根目录中的版本号不一致，请检查后重新上传', 409);
  const nameVersion = uniqueNameVersions[0] ?? null;
  invariant(!configVersion || !nameVersion || configVersion === nameVersion, 'SOURCE_VERSION_CONFLICT', 'config.json 与 ZIP 文件名或根目录中的版本号不一致', 409);
  const version = configVersion ?? nameVersion;
  const configuredName = [config.display_name, config.displayName, config.theme?.display_name, config.theme?.name, config.name]
    .find((value) => typeof value === 'string' && value.trim())?.trim() ?? null;
  const displayName = version ? (configuredName
    ? (configuredName.includes(version) ? configuredName : `${configuredName} ${version}`)
    : `APPGOG ${version}`) : configuredName;
  return { version, displayName };
}

export function createPortalService({ repository, queue, licenseService, artifactStore, buildEngine, config, clock = () => new Date() }) {
  const serviceConfig = Object.freeze({
    license_service_enabled: 'licenseServiceEnabled',
    customer_login_enabled: 'customerLoginEnabled',
    build_center_enabled: 'buildCenterEnabled',
    new_builds_enabled: 'newBuildsEnabled',
    worker_enabled: 'workerEnabled',
  });
  function customerLicense(session) {
    const license = repository.licenseById(session.actor_id);
    invariant(license && license.status === 'active', 'LICENSE_INACTIVE', '授权已停用', 403);
    return license;
  }

  function boolSetting(key, fallback = true) {
    const value = repository.setting(key);
    return value === null ? fallback : value === 'true';
  }

  function publicNode(node) {
    let capabilities = [];
    try { capabilities = JSON.parse(node.capabilities_json ?? '[]'); } catch { capabilities = []; }
    return {
      id: node.id, name: node.name, role: node.role, public_url: node.public_url,
      credential_prefix: node.credential_prefix, status: node.status, capabilities,
      last_seen_at: node.last_seen_at, created_at: node.created_at, updated_at: node.updated_at,
    };
  }

  function optionalHttpUrl(value, code = 'CMS_URL_INVALID') {
    const text = String(value ?? '').trim();
    if (!text) return null;
    let parsed;
    try { parsed = new URL(text); } catch { invariant(false, code, '站点地址格式无效'); }
    invariant(['http:', 'https:'].includes(parsed.protocol), code, '站点地址必须使用 HTTP 或 HTTPS');
    return text.replace(/\/+$/, '');
  }

  return {
    repository,
    serviceEnabled(key, fallback = true) {
      const property = serviceConfig[key];
      return property ? config[property] !== false : boolSetting(key, fallback);
    },
    cmsSettings() {
      const saved = repository.listSettings();
      const announcementEnabled = saved.announcement_enabled === 'true' && Boolean(saved.announcement_title?.trim() || saved.announcement_body?.trim());
      return {
        platform_name: saved.platform_name ?? 'APPGOG打包授权系统',
        installation_role: config.role ?? (config.surface === 'combined' ? 'all-in-one' : 'license-center'),
        license_public_url: config.publicBaseUrl,
        build_public_url: config.buildCenterPublicUrl,
        domain_migration_cooldown_hours: Math.max(0, Number(saved.domain_migration_cooldown_hours) || 0),
        announcement_title: saved.announcement_title ?? '',
        announcement_body: saved.announcement_body ?? '',
        announcement_enabled: announcementEnabled,
        announcement_published_at: saved.announcement_published_at ?? null,
        license_service_enabled: config.licenseServiceEnabled !== false,
        customer_login_enabled: config.customerLoginEnabled !== false,
        build_center_enabled: config.buildCenterEnabled !== false,
        new_builds_enabled: config.newBuildsEnabled !== false,
        worker_enabled: config.workerEnabled !== false,
        nodes: repository.listServiceNodes().map(publicNode),
      };
    },
    updateCmsSettings(input, actorId) {
      const now = clock().toISOString();
      const deploymentFields = ['license_public_url', 'build_public_url', 'license_service_enabled', 'customer_login_enabled', 'build_center_enabled', 'new_builds_enabled', 'worker_enabled'];
      invariant(!deploymentFields.some((key) => input[key] !== undefined), 'DEPLOYMENT_SETTING_READ_ONLY', '域名和服务开关只能通过 Linux appgog 管理菜单修改', 403);
      const textFields = ['platform_name', 'announcement_title', 'announcement_body'];
      const booleanFields = ['announcement_enabled'];
      for (const key of textFields) {
        if (input[key] === undefined) continue;
        const value = String(input[key]).trim();
        const maximum = key === 'announcement_body' ? 4000 : 200;
        invariant(key !== 'platform_name' || value.length >= 2, 'CMS_SETTING_INVALID', '平台名称至少 2 个字符');
        invariant(value.length <= maximum, 'CMS_SETTING_INVALID', `${key} 配置过长`);
        repository.setSetting(key, value, now);
      }
      for (const key of booleanFields) {
        if (input[key] !== undefined) repository.setSetting(key, input[key] === true ? 'true' : 'false', now);
      }
      if (input.domain_migration_cooldown_hours !== undefined) {
        const hours = Number(input.domain_migration_cooldown_hours);
        invariant(Number.isInteger(hours) && hours >= 0 && hours <= 8760, 'DOMAIN_MIGRATION_COOLDOWN_INVALID', '域名换绑冷却必须是 0–8760 小时的整数');
        repository.setSetting('domain_migration_cooldown_hours', String(hours), now);
      }
      if (input.announcement_enabled === true || input.announcement_title !== undefined || input.announcement_body !== undefined) {
        repository.setSetting('announcement_published_at', now, now);
      }
      repository.audit({ actorType: 'admin', actorId, action: 'cms.settings.updated', subjectType: 'system',
        subjectId: 'cms', metadata: { keys: [...textFields, ...booleanFields, 'domain_migration_cooldown_hours'].filter((key) => input[key] !== undefined) }, now });
      return this.cmsSettings();
    },
    createServiceNode(input, actorId) {
      invariant(['build-center', 'worker'].includes(input.role), 'NODE_ROLE_INVALID', '节点角色无效');
      const name = String(input.name ?? '').trim();
      invariant(name.length >= 2 && name.length <= 80, 'NODE_NAME_INVALID', '节点名称必须为 2–80 个字符');
      const credential = newNodeCredential(input.role);
      const now = clock().toISOString();
      const capabilities = input.role === 'worker' ? ['build.lease', 'build.transfer'] : ['customer.proxy'];
      const node = repository.createServiceNode({
        name, role: input.role, publicUrl: optionalHttpUrl(input.public_url, 'NODE_URL_INVALID'),
        credentialPrefix: keyPrefix(credential), credentialHash: hashSecret(credential, config.pepper), capabilities, now,
      });
      repository.audit({ actorType: 'admin', actorId, action: 'service_node.created', subjectType: 'service_node',
        subjectId: node.id, metadata: { name, role: input.role }, now });
      return { node: publicNode(node), credential };
    },
    changeServiceNodeStatus(id, status, actorId) {
      invariant(['active', 'disabled'].includes(status), 'NODE_STATUS_INVALID', '节点状态无效');
      const now = clock().toISOString();
      const node = repository.changeServiceNodeStatus(id, status, now);
      invariant(node, 'NODE_NOT_FOUND', '节点不存在', 404);
      repository.audit({ actorType: 'admin', actorId, action: `service_node.${status}`, subjectType: 'service_node', subjectId: id, now });
      return publicNode(node);
    },
    rotateServiceNodeCredential(id, actorId) {
      const current = repository.serviceNodeById(id);
      invariant(current, 'NODE_NOT_FOUND', '节点不存在', 404);
      const credential = newNodeCredential(current.role);
      const now = clock().toISOString();
      const node = repository.rotateServiceNodeCredential(id, keyPrefix(credential), hashSecret(credential, config.pepper), now);
      repository.audit({ actorType: 'admin', actorId, action: 'service_node.credential_rotated', subjectType: 'service_node', subjectId: id, now });
      return { node: publicNode(node), credential };
    },
    customerOverview(session) {
      const license = customerLicense(session);
      const builds = repository.listBuildJobsByLicense(license.id, 30);
      const currentVersion = repository.activeActivationByLicense(license.id)?.version ?? null;
      const versions = repository.listActiveSourceVersions(license.product_code);
      const latestVersion = versions[0]?.version ?? null;
      const migration = repository.latestApprovedDomainMigrationByLicense(license.id);
      const cooldownHours = Math.max(0, Number(repository.setting('domain_migration_cooldown_hours')) || 0);
      const nextAllowedAt = migration?.reviewed_at && cooldownHours > 0
        ? new Date(new Date(migration.reviewed_at).getTime() + cooldownHours * 60 * 60 * 1000).toISOString()
        : null;
      const announcementTitle = repository.setting('announcement_title') ?? '';
      const announcementBody = repository.setting('announcement_body') ?? '';
      const announcementEnabled = repository.setting('announcement_enabled') === 'true' && Boolean(announcementTitle.trim() || announcementBody.trim());
      const buildsUsed = repository.recentBuildCount(license.id, new Date(clock().getTime() - 24 * 60 * 60 * 1000).toISOString());
      return {
        license: {
          product: license.product_code,
          key_prefix: license.key_prefix,
          status: license.status,
          bound_domain: license.bound_domain,
          update_until: license.update_until,
          max_builds_per_day: license.max_builds_per_day,
          builds_used_last_24_hours: buildsUsed,
          builds_remaining: Math.max(0, license.max_builds_per_day - buildsUsed),
          generation: license.generation,
        },
        domain_migration: migration ? {
          id: migration.id,
          previous_domain: migration.previous_domain,
          requested_domain: migration.requested_domain,
          status: migration.status,
          reason: migration.reason,
          requested_at: migration.requested_at,
          reviewed_at: migration.reviewed_at,
          cooldown_hours: cooldownHours,
          next_allowed_at: nextAllowedAt,
          cooldown_active: Boolean(nextAllowedAt && clock() < new Date(nextAllowedAt)),
        } : null,
        domain_migration_policy: {
          cooldown_hours: cooldownHours,
          next_allowed_at: nextAllowedAt,
          cooldown_active: Boolean(nextAllowedAt && clock() < new Date(nextAllowedAt)),
        },
        announcement: announcementEnabled ? {
          title: announcementTitle,
          body: announcementBody,
          published_at: repository.setting('announcement_published_at'),
        } : null,
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

    bindCustomerDomain(session, { domain }) {
      customerLicense(session);
      const license = licenseService.bindLicenseDomain({ licenseId: session.actor_id, domain, actorId: session.actor_id });
      return { bound_domain: license.bound_domain, generation: license.generation };
    },

    requestCustomerDomainMigration(session, { domain, reason }) {
      customerLicense(session);
      const cooldownHours = Math.max(0, Number(repository.setting('domain_migration_cooldown_hours')) || 0);
      const result = licenseService.selfServiceDomainMigration({
        licenseId: session.actor_id, domain, reason, cooldownHours, actorId: session.actor_id,
      });
      return {
        id: result.request.id,
        previous_domain: result.request.previous_domain,
        requested_domain: result.request.requested_domain,
        status: result.request.status,
        requested_at: result.request.requested_at,
        reviewed_at: result.request.reviewed_at,
        bound_domain: result.license.bound_domain,
        generation: result.license.generation,
      };
    },

    reviewDomainMigration({ requestId, decision, reviewNote, actorId }) {
      const result = licenseService.reviewDomainMigration({ requestId, decision, reviewNote, reviewerId: actorId });
      return {
        id: result.request.id,
        status: result.request.status,
        reviewed_at: result.request.reviewed_at,
        bound_domain: result.license.bound_domain,
        generation: result.license.generation,
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

    publishSourceVersion({ productCode = 'appgog', version, displayName, sourceFilename, zipBuffer, releaseNotes, channel, releaseKind, minXboardVersion, minUpgradeVersion, rollbackAllowed, rollbackTo, actorId = null }) {
      invariant(Buffer.isBuffer(zipBuffer) && zipBuffer.length > 0, 'SOURCE_REQUIRED', '必须上传主题 ZIP');
      invariant(zipBuffer.length <= config.maxSourceUploadBytes, 'SOURCE_TOO_LARGE', '上传的主题 ZIP 超出大小限制', 413);
      const validation = buildEngine.validateSource(zipBuffer);
      const detected = sourceMetadata(validation.files, sourceFilename);
      const product = licenseService.ensureProduct({ code: productCode, name: productCode.toUpperCase() });
      const requestedVersion = version?.trim() || null;
      invariant(!requestedVersion || !detected.version || requestedVersion === detected.version,
        'SOURCE_VERSION_CONFLICT', `填写的版本号与安装包识别结果 ${detected.version} 不一致`, 409);
      const normalizedVersion = requestedVersion ?? detected.version;
      invariant(normalizedVersion, 'VERSION_REQUIRED', '无法自动识别版本号，请手动填写后重试');
      invariant(VERSION_PATTERN.test(normalizedVersion), 'VERSION_INVALID', '版本号格式无效，请使用例如 1.8.11 的格式');
      const normalizedDisplayName = displayName?.trim() || detected.displayName || `APPGOG ${normalizedVersion}`;
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
          displayName: normalizedDisplayName,
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
           metadata: { version: source.version, display_name: source.display_name, source_filename: sourceFilename ?? null, source_ref: sourceRef, size: zipBuffer.length },
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
        domain_migrations: repository.listDomainMigrations(100).map((request) => ({
          id: request.id,
          license_id: request.license_id,
          customer_ref: request.customer_ref,
          previous_domain: request.previous_domain,
          requested_domain: request.requested_domain,
          status: request.status,
          reason: request.reason,
          requested_at: request.requested_at,
          reviewed_at: request.reviewed_at,
          review_note: request.review_note,
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
        cms: this.cmsSettings(),
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
          build: { ...claimedBuild, licenseServer: this.cmsSettings().license_public_url },
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
      invariant(secretMatches(result.package_proof, build.package_secret_hash, config.pepper), 'PACKAGE_PROOF_INVALID', 'Worker 返回的 Package Secret 与构建身份不匹配', 409);
      const watermark = createHash('sha256').update(`${build.license_id}:${build.id}:${build.package_id}`).digest('hex');
      buildEngine.verifyArtifact({
        buffer: artifactBuffer,
        packageSecret: result.package_proof,
        expected: {
          issuer: config.publicBaseUrl,
          product: build.product_code,
          version: build.version,
          build_id: build.id,
          package_id: build.package_id,
          domain: build.domain,
          watermark,
        },
      });
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

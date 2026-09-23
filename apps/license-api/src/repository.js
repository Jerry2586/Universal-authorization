import { newId } from '../../../packages/core/src/identifiers.js';

export function createRepository(database) {
  const queries = {
    insertProduct: database.prepare(`INSERT INTO products (id, code, name, created_at) VALUES (?, ?, ?, ?)`),
    productByCode: database.prepare(`SELECT * FROM products WHERE code = ?`),
    insertLicense: database.prepare(`
      INSERT INTO licenses (id, product_id, customer_ref, key_prefix, key_hash, status, bound_domain, update_until, max_builds_per_day, generation, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `),
    licenseByHash: database.prepare(`
      SELECT licenses.*, products.code AS product_code, products.name AS product_name
      FROM licenses JOIN products ON products.id = licenses.product_id WHERE licenses.key_hash = ?
    `),
    licenseById: database.prepare(`
      SELECT licenses.*, products.code AS product_code, products.name AS product_name
      FROM licenses JOIN products ON products.id = licenses.product_id WHERE licenses.id = ?
    `),
    bindDomain: database.prepare(`UPDATE licenses SET bound_domain = ?, updated_at = ? WHERE id = ? AND bound_domain IS NULL`),
    rotateLicense: database.prepare(`UPDATE licenses SET key_prefix = ?, key_hash = ?, generation = generation + 1, updated_at = ? WHERE id = ?`),
    insertTicket: database.prepare(`
      INSERT INTO build_tickets (id, license_id, token_hash, requested_version, requested_domain, status, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, 'created', ?, ?)
    `),
    ticketByHash: database.prepare(`
      SELECT build_tickets.*, licenses.status AS license_status, licenses.generation AS license_generation,
        licenses.bound_domain, products.code AS product_code
      FROM build_tickets
      JOIN licenses ON licenses.id = build_tickets.license_id
      JOIN products ON products.id = licenses.product_id
      WHERE build_tickets.token_hash = ?
    `),
    claimTicket: database.prepare(`UPDATE build_tickets SET status = 'claimed', claimed_at = ? WHERE id = ? AND status = 'created'`),
    consumeTicket: database.prepare(`UPDATE build_tickets SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'claimed'`),
    insertBuild: database.prepare(`
      INSERT INTO builds (id, license_id, ticket_id, version, domain, package_id, package_secret_hash, artifact_sha256, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?)
    `),
    buildById: database.prepare(`
      SELECT builds.*, licenses.status AS license_status, licenses.generation AS license_generation,
        licenses.bound_domain, products.code AS product_code
      FROM builds
      JOIN licenses ON licenses.id = builds.license_id
      JOIN products ON products.id = licenses.product_id
      WHERE builds.id = ?
    `),
    markBuildActivated: database.prepare(`UPDATE builds SET status = 'activated', activated_at = COALESCE(activated_at, ?) WHERE id = ?`),
    insertInstallKey: database.prepare(`
      INSERT INTO install_keys (id, build_id, key_prefix, key_hash, status, expires_at, created_at)
      VALUES (?, ?, ?, ?, 'available', ?, ?)
    `),
    installKeyByHash: database.prepare(`
      SELECT install_keys.*, builds.license_id, builds.package_id, builds.domain, builds.version, builds.status AS build_status,
        licenses.status AS license_status, licenses.generation AS license_generation, licenses.bound_domain,
        products.code AS product_code
      FROM install_keys
      JOIN builds ON builds.id = install_keys.build_id
      JOIN licenses ON licenses.id = builds.license_id
      JOIN products ON products.id = licenses.product_id
      WHERE install_keys.key_hash = ?
    `),
    installKeyByBuildId: database.prepare(`SELECT * FROM install_keys WHERE build_id = ?`),
    consumeInstallKey: database.prepare(`UPDATE install_keys SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'available'`),
    insertActivation: database.prepare(`
      INSERT INTO activations (id, license_id, build_id, domain, backend_origin, installation_id, status, generation, refresh_secret_hash, last_seen_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `),
    supersedeActivations: database.prepare(`
      UPDATE activations SET status = 'superseded', revoked_at = ?
      WHERE license_id = ? AND domain = ? AND status = 'active'
    `),
    activationById: database.prepare(`
      SELECT activations.*, licenses.status AS license_status, licenses.generation AS license_generation,
        licenses.bound_domain, builds.package_id, builds.version, builds.status AS build_status, products.code AS product_code
      FROM activations
      JOIN licenses ON licenses.id = activations.license_id
      JOIN builds ON builds.id = activations.build_id
      JOIN products ON products.id = licenses.product_id
      WHERE activations.id = ?
    `),
    updateActivationSeen: database.prepare(`UPDATE activations SET last_seen_at = ? WHERE id = ?`),
    insertAudit: database.prepare(`
      INSERT INTO audit_events (id, actor_type, actor_id, action, subject_type, subject_id, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    countRecentBuilds: database.prepare(`SELECT COUNT(*) AS count FROM builds WHERE license_id = ? AND created_at >= ? AND status != 'revoked'`),
    insertSession: database.prepare(`
      INSERT INTO web_sessions (id, token_hash, csrf_token, actor_type, actor_id, expires_at, last_seen_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    sessionByHash: database.prepare(`SELECT * FROM web_sessions WHERE token_hash = ?`),
    touchSession: database.prepare(`UPDATE web_sessions SET last_seen_at = ? WHERE id = ?`),
    deleteSession: database.prepare(`DELETE FROM web_sessions WHERE id = ?`),
    deleteExpiredSessions: database.prepare(`DELETE FROM web_sessions WHERE expires_at < ?`),
    insertSourceVersion: database.prepare(`
      INSERT INTO source_versions (
        id, product_id, version, display_name, source_kind, source_ref, status,
        release_notes, channel, release_kind, min_xboard_version, min_upgrade_version,
        rollback_allowed, rollback_to, published_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    sourceVersionById: database.prepare(`
      SELECT source_versions.*, products.code AS product_code
      FROM source_versions JOIN products ON products.id = source_versions.product_id
      WHERE source_versions.id = ?
    `),
    sourceVersionByProductVersion: database.prepare(`
      SELECT source_versions.*, products.code AS product_code
      FROM source_versions JOIN products ON products.id = source_versions.product_id
      WHERE products.code = ? AND source_versions.version = ?
    `),
    publishSourceVersion: database.prepare(`
      UPDATE source_versions
      SET display_name = ?, source_kind = ?, source_ref = ?, release_notes = ?, channel = ?, release_kind = ?,
        min_xboard_version = ?, min_upgrade_version = ?, rollback_allowed = ?, rollback_to = ?,
        published_at = ?, status = 'active', withdrawn_reason = NULL
      WHERE id = ? AND status = 'draft'
    `),
    listActiveSourceVersions: database.prepare(`
      SELECT source_versions.*, products.code AS product_code
      FROM source_versions JOIN products ON products.id = source_versions.product_id
      WHERE products.code = ? AND source_versions.status = 'active'
      ORDER BY COALESCE(source_versions.published_at, source_versions.created_at) DESC
    `),
    listSourceVersions: database.prepare(`
      SELECT source_versions.*, products.code AS product_code
      FROM source_versions JOIN products ON products.id = source_versions.product_id
      WHERE products.code = ? ORDER BY COALESCE(source_versions.published_at, source_versions.created_at) DESC
    `),
    insertBuildJob: database.prepare(`
      INSERT INTO build_jobs (
        id, license_id, source_version_id, requested_version, requested_domain, intent, base_version, source_kind, upload_ref,
        status, progress, status_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)
    `),
    buildJobById: database.prepare(`
      SELECT build_jobs.*, licenses.customer_ref, licenses.bound_domain, products.code AS product_code
      FROM build_jobs
      JOIN licenses ON licenses.id = build_jobs.license_id
      JOIN products ON products.id = licenses.product_id
      WHERE build_jobs.id = ?
    `),
    listBuildJobsByLicense: database.prepare(`
      SELECT build_jobs.*, licenses.customer_ref, products.code AS product_code
      FROM build_jobs
      JOIN licenses ON licenses.id = build_jobs.license_id
      JOIN products ON products.id = licenses.product_id
      WHERE build_jobs.license_id = ?
      ORDER BY build_jobs.created_at DESC LIMIT ?
    `),
    listBuildJobs: database.prepare(`
      SELECT build_jobs.*, licenses.customer_ref, products.code AS product_code
      FROM build_jobs
      JOIN licenses ON licenses.id = build_jobs.license_id
      JOIN products ON products.id = licenses.product_id
      ORDER BY build_jobs.created_at DESC LIMIT ?
    `),
    nextQueuedJob: database.prepare(`
      SELECT * FROM build_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1
    `),
    leaseBuildJob: database.prepare(`
      UPDATE build_jobs
      SET status = 'processing', progress = 5, status_message = ?, lease_owner = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'queued'
    `),
    assignBuildToJob: database.prepare(`
      UPDATE build_jobs SET build_id = ? WHERE id = ? AND status = 'processing' AND lease_owner = ? AND build_id IS NULL
    `),
    updateBuildJobProgress: database.prepare(`
      UPDATE build_jobs SET progress = ?, status_message = ?, updated_at = ?
      WHERE id = ? AND status = 'processing' AND lease_owner = ?
    `),
    completeBuildJob: database.prepare(`
      UPDATE build_jobs SET status = 'succeeded', progress = 100, status_message = ?, build_id = ?, artifact_ref = ?,
        artifact_sha256 = ?, install_key_encrypted = ?, updated_at = ?, completed_at = ?, lease_expires_at = NULL
      WHERE id = ? AND status = 'processing' AND lease_owner = ?
    `),
    failBuildJob: database.prepare(`
      UPDATE build_jobs SET status = 'failed', status_message = ?, error_code = ?, updated_at = ?, completed_at = ?, lease_expires_at = NULL
      WHERE id = ? AND status = 'processing' AND lease_owner = ?
    `),
    revokeBuild: database.prepare(`UPDATE builds SET status = 'revoked' WHERE id = ? AND status = 'ready'`),
    revokeInstallKeyByBuild: database.prepare(`UPDATE install_keys SET status = 'revoked' WHERE build_id = ? AND status = 'available'`),
    listLicenses: database.prepare(`
      SELECT licenses.*, products.code AS product_code, products.name AS product_name,
        (SELECT COUNT(*) FROM builds WHERE builds.license_id = licenses.id) AS build_count,
        (SELECT COUNT(*) FROM activations WHERE activations.license_id = licenses.id AND activations.status = 'active') AS active_activation_count
      FROM licenses JOIN products ON products.id = licenses.product_id
      ORDER BY licenses.created_at DESC LIMIT ?
    `),
    listActivations: database.prepare(`
      SELECT activations.*, licenses.customer_ref, builds.version, products.code AS product_code
      FROM activations
      JOIN licenses ON licenses.id = activations.license_id
      JOIN builds ON builds.id = activations.build_id
      JOIN products ON products.id = licenses.product_id
      ORDER BY activations.created_at DESC LIMIT ?
    `),
    activeActivationByLicense: database.prepare(`
      SELECT activations.*, builds.version FROM activations
      JOIN builds ON builds.id = activations.build_id
      WHERE activations.license_id = ? AND activations.status = 'active'
      ORDER BY activations.created_at DESC LIMIT 1
    `),
    listAudit: database.prepare(`SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?`),
    countLicenses: database.prepare(`SELECT COUNT(*) AS count FROM licenses`),
    countActiveLicenses: database.prepare(`SELECT COUNT(*) AS count FROM licenses WHERE status = 'active'`),
    countBuildJobsToday: database.prepare(`SELECT COUNT(*) AS count FROM build_jobs WHERE created_at >= ?`),
    countActivationsToday: database.prepare(`SELECT COUNT(*) AS count FROM activations WHERE created_at >= ?`),
    countActiveActivations: database.prepare(`SELECT COUNT(*) AS count FROM activations WHERE status = 'active'`),
    countQueuedJobs: database.prepare(`SELECT COUNT(*) AS count FROM build_jobs WHERE status IN ('queued', 'processing')`),
    insertAdmin: database.prepare(`
      INSERT INTO admin_users (id, username, display_name, password_hash, role, permissions_json, is_owner, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `),
    adminByUsername: database.prepare(`SELECT * FROM admin_users WHERE username = ?`),
    adminById: database.prepare(`SELECT * FROM admin_users WHERE id = ?`),
    listAdmins: database.prepare(`SELECT * FROM admin_users ORDER BY is_owner DESC, created_at ASC`),
    updateAdminLogin: database.prepare(`UPDATE admin_users SET last_login_at = ?, last_login_ip = ?, updated_at = ? WHERE id = ?`),
    changeAdminStatus: database.prepare(`UPDATE admin_users SET status = ?, updated_at = ? WHERE id = ? AND is_owner = 0`),
    updateAdminPassword: database.prepare(`UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE id = ?`),
    revokeAdminSessions: database.prepare(`DELETE FROM web_sessions WHERE actor_type = 'admin' AND actor_id = ?`),
    withdrawSourceVersion: database.prepare(`UPDATE source_versions SET status = 'withdrawn', withdrawn_reason = ? WHERE id = ? AND status = 'active'`),
    settingByKey: database.prepare(`SELECT * FROM system_settings WHERE key = ?`),
    listSettings: database.prepare(`SELECT * FROM system_settings ORDER BY key ASC`),
    upsertSetting: database.prepare(`
      INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `),
    insertServiceNode: database.prepare(`
      INSERT INTO service_nodes (id, name, role, public_url, credential_prefix, credential_hash, status, capabilities_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `),
    serviceNodeById: database.prepare(`SELECT * FROM service_nodes WHERE id = ?`),
    serviceNodeByCredentialHash: database.prepare(`SELECT * FROM service_nodes WHERE credential_hash = ?`),
    listServiceNodes: database.prepare(`SELECT * FROM service_nodes ORDER BY created_at DESC`),
    updateServiceNodeSeen: database.prepare(`UPDATE service_nodes SET last_seen_at = ?, updated_at = ? WHERE id = ? AND status = 'active'`),
    updateServiceNodeStatus: database.prepare(`UPDATE service_nodes SET status = ?, updated_at = ? WHERE id = ?`),
    rotateServiceNodeCredential: database.prepare(`
      UPDATE service_nodes SET credential_prefix = ?, credential_hash = ?, updated_at = ? WHERE id = ?
    `),
    changeLicenseDomain: database.prepare(`
      UPDATE licenses SET bound_domain = ?, generation = generation + 1, updated_at = ? WHERE id = ?
    `),
    changeLicenseStatus: database.prepare(`UPDATE licenses SET status = ?, updated_at = ? WHERE id = ?`),
  };

  return {
    createProduct({ code, name, now }) {
      const id = newId('prd');
      queries.insertProduct.run(id, code, name, now);
      return queries.productByCode.get(code);
    },
    productByCode: (code) => queries.productByCode.get(code),
    createLicense(values) {
      queries.insertLicense.run(
        values.id, values.productId, values.customerRef, values.keyPrefix, values.keyHash,
        values.status, values.boundDomain ?? null, values.updateUntil ?? null,
        values.maxBuildsPerDay, values.now, values.now,
      );
      return queries.licenseById.get(values.id);
    },
    licenseByHash: (hash) => queries.licenseByHash.get(hash),
    licenseById: (id) => queries.licenseById.get(id),
    bindDomain(id, domain, now) {
      queries.bindDomain.run(domain, now, id);
      return queries.licenseById.get(id);
    },
    rotateLicense(id, prefix, hash, now) {
      queries.rotateLicense.run(prefix, hash, now, id);
      return queries.licenseById.get(id);
    },
    createTicket(values) {
      queries.insertTicket.run(values.id, values.licenseId, values.tokenHash, values.version, values.domain, values.expiresAt, values.now);
      return values.id;
    },
    ticketByHash: (hash) => queries.ticketByHash.get(hash),
    claimTicket: (id, now) => queries.claimTicket.run(now, id).changes === 1,
    consumeTicket: (id, now) => queries.consumeTicket.run(now, id).changes === 1,
    createBuild(values) {
      queries.insertBuild.run(
        values.id, values.licenseId, values.ticketId, values.version, values.domain,
        values.packageId, values.packageSecretHash, values.artifactSha256 ?? null, values.now,
      );
      return queries.buildById.get(values.id);
    },
    buildById: (id) => queries.buildById.get(id),
    markBuildActivated: (id, now) => queries.markBuildActivated.run(now, id),
    createInstallKey(values) {
      queries.insertInstallKey.run(values.id, values.buildId, values.keyPrefix, values.keyHash, values.expiresAt ?? null, values.now);
    },
    installKeyByHash: (hash) => queries.installKeyByHash.get(hash),
    installKeyByBuildId: (buildId) => queries.installKeyByBuildId.get(buildId),
    consumeInstallKey: (id, now) => queries.consumeInstallKey.run(now, id).changes === 1,
    supersedeActivations: (licenseId, domain, now) => queries.supersedeActivations.run(now, licenseId, domain),
    createActivation(values) {
      queries.insertActivation.run(
        values.id, values.licenseId, values.buildId, values.domain, values.backendOrigin,
        values.installationId, values.generation, values.refreshSecretHash, values.now, values.now,
      );
      return queries.activationById.get(values.id);
    },
    activationById: (id) => queries.activationById.get(id),
    updateActivationSeen: (id, now) => queries.updateActivationSeen.run(now, id),
    audit({ actorType, actorId = null, action, subjectType, subjectId = null, metadata = {}, now }) {
      queries.insertAudit.run(newId('evt'), actorType, actorId, action, subjectType, subjectId, JSON.stringify(metadata), now);
    },
    recentBuildCount(licenseId, since) {
      return queries.countRecentBuilds.get(licenseId, since).count;
    },
    createSession(values) {
      queries.insertSession.run(
        values.id, values.tokenHash, values.csrfToken, values.actorType, values.actorId ?? null,
        values.expiresAt, values.now, values.now,
      );
      return queries.sessionByHash.get(values.tokenHash);
    },
    sessionByHash: (hash) => queries.sessionByHash.get(hash),
    touchSession: (id, now) => queries.touchSession.run(now, id),
    deleteSession: (id) => queries.deleteSession.run(id),
    deleteExpiredSessions: (now) => queries.deleteExpiredSessions.run(now),
    createSourceVersion(values) {
      const id = values.id ?? newId('src');
      queries.insertSourceVersion.run(
        id, values.productId, values.version, values.displayName, values.sourceKind,
        values.sourceRef ?? null, values.status ?? 'active', values.releaseNotes ?? '', values.channel ?? 'stable',
        values.releaseKind ?? 'feature', values.minXboardVersion ?? null, values.minUpgradeVersion ?? null,
        values.rollbackAllowed === false ? 0 : 1, values.rollbackTo ?? null,
        (values.status ?? 'active') === 'active' ? values.now : null, values.now,
      );
      return queries.sourceVersionById.get(id);
    },
    sourceVersionById: (id) => queries.sourceVersionById.get(id),
    sourceVersionByProductVersion: (productCode, version) => queries.sourceVersionByProductVersion.get(productCode, version),
    publishSourceVersion(values) {
      const changed = queries.publishSourceVersion.run(
        values.displayName, values.sourceKind, values.sourceRef, values.releaseNotes ?? '', values.channel ?? 'stable',
        values.releaseKind ?? 'feature', values.minXboardVersion ?? null, values.minUpgradeVersion ?? null,
        values.rollbackAllowed === false ? 0 : 1, values.rollbackTo ?? null, values.now, values.id,
      ).changes;
      return changed === 1 ? queries.sourceVersionById.get(values.id) : null;
    },
    listActiveSourceVersions: (productCode) => queries.listActiveSourceVersions.all(productCode),
    listSourceVersions: (productCode) => queries.listSourceVersions.all(productCode),
    createBuildJob(values) {
      queries.insertBuildJob.run(
        values.id, values.licenseId, values.sourceVersionId ?? null, values.version, values.domain,
        values.intent ?? 'install', values.baseVersion ?? null, values.sourceKind, values.uploadRef ?? null,
        values.message ?? '等待构建 Worker', values.now, values.now,
      );
      return queries.buildJobById.get(values.id);
    },
    buildJobById: (id) => queries.buildJobById.get(id),
    listBuildJobsByLicense: (licenseId, limit = 50) => queries.listBuildJobsByLicense.all(licenseId, limit),
    listBuildJobs: (limit = 100) => queries.listBuildJobs.all(limit),
    nextQueuedJob: () => queries.nextQueuedJob.get(),
    leaseBuildJob(values) {
      const changed = queries.leaseBuildJob.run(values.message, values.workerId, values.leaseExpiresAt, values.now, values.id).changes;
      return changed === 1 ? queries.buildJobById.get(values.id) : null;
    },
    assignBuildToJob(id, workerId, buildId) {
      return queries.assignBuildToJob.run(buildId, id, workerId).changes === 1;
    },
    updateBuildJobProgress(values) {
      return queries.updateBuildJobProgress.run(values.progress, values.message, values.now, values.id, values.workerId).changes === 1;
    },
    completeBuildJob(values) {
      const changed = queries.completeBuildJob.run(
        values.message, values.buildId, values.artifactRef, values.artifactSha256,
        values.installKeyEncrypted, values.now, values.now, values.id, values.workerId,
      ).changes;
      return changed === 1 ? queries.buildJobById.get(values.id) : null;
    },
    failBuildJob(values) {
      const job = queries.buildJobById.get(values.id);
      const changed = queries.failBuildJob.run(values.message, values.errorCode, values.now, values.now, values.id, values.workerId).changes;
      if (changed === 1 && job?.build_id) {
        queries.revokeBuild.run(job.build_id);
        queries.revokeInstallKeyByBuild.run(job.build_id);
      }
      return changed === 1 ? queries.buildJobById.get(values.id) : null;
    },
    revokeUnactivatedBuild(buildId) {
      queries.revokeBuild.run(buildId);
      queries.revokeInstallKeyByBuild.run(buildId);
    },
    listLicenses: (limit = 100) => queries.listLicenses.all(limit),
    listActivations: (limit = 100) => queries.listActivations.all(limit),
    activeActivationByLicense: (licenseId) => queries.activeActivationByLicense.get(licenseId),
    listAudit(limit = 100) {
      return queries.listAudit.all(limit).map((event) => ({ ...event, metadata: JSON.parse(event.metadata_json) }));
    },
    dashboardStats(since) {
      return {
        licenses: queries.countLicenses.get().count,
        activeLicenses: queries.countActiveLicenses.get().count,
        buildsToday: queries.countBuildJobsToday.get(since).count,
        activationsToday: queries.countActivationsToday.get(since).count,
        activeActivations: queries.countActiveActivations.get().count,
        queuedJobs: queries.countQueuedJobs.get().count,
      };
    },
    createAdmin(values) {
      const id = values.id ?? newId('adm');
      queries.insertAdmin.run(
        id, values.username, values.displayName ?? values.username, values.passwordHash,
        values.role ?? 'support', JSON.stringify(values.permissions ?? []), values.isOwner ? 1 : 0,
        values.now, values.now,
      );
      return queries.adminById.get(id);
    },
    adminByUsername: (username) => queries.adminByUsername.get(username),
    adminById: (id) => queries.adminById.get(id),
    listAdmins: () => queries.listAdmins.all(),
    updateAdminLogin(id, ip, now) {
      queries.updateAdminLogin.run(now, ip ?? null, now, id);
      return queries.adminById.get(id);
    },
    changeAdminStatus(id, status, now) {
      const changed = queries.changeAdminStatus.run(status, now, id).changes;
      return changed === 1 ? queries.adminById.get(id) : null;
    },
    updateAdminPassword(id, passwordHash, now) {
      const changed = queries.updateAdminPassword.run(passwordHash, now, id).changes;
      return changed === 1 ? queries.adminById.get(id) : null;
    },
    revokeAdminSessions(id) { queries.revokeAdminSessions.run(id); },
    setting(key) {
      const record = queries.settingByKey.get(key);
      return record ? record.value : null;
    },
    listSettings() {
      return Object.fromEntries(queries.listSettings.all().map((record) => [record.key, record.value]));
    },
    setSetting(key, value, now) {
      queries.upsertSetting.run(key, String(value), now);
      return queries.settingByKey.get(key);
    },
    createServiceNode(values) {
      const id = values.id ?? newId('nod');
      queries.insertServiceNode.run(
        id, values.name, values.role, values.publicUrl ?? null, values.credentialPrefix,
        values.credentialHash, JSON.stringify(values.capabilities ?? []), values.now, values.now,
      );
      return queries.serviceNodeById.get(id);
    },
    serviceNodeById: (id) => queries.serviceNodeById.get(id),
    serviceNodeByCredentialHash: (hash) => queries.serviceNodeByCredentialHash.get(hash),
    listServiceNodes: () => queries.listServiceNodes.all(),
    touchServiceNode(id, now) {
      queries.updateServiceNodeSeen.run(now, now, id);
      return queries.serviceNodeById.get(id);
    },
    changeServiceNodeStatus(id, status, now) {
      return queries.updateServiceNodeStatus.run(status, now, id).changes === 1 ? queries.serviceNodeById.get(id) : null;
    },
    rotateServiceNodeCredential(id, prefix, hash, now) {
      return queries.rotateServiceNodeCredential.run(prefix, hash, now, id).changes === 1 ? queries.serviceNodeById.get(id) : null;
    },
    withdrawSourceVersion(id, reason) {
      return queries.withdrawSourceVersion.run(reason, id).changes === 1 ? queries.sourceVersionById.get(id) : null;
    },
    changeLicenseDomain(id, domain, now) {
      queries.changeLicenseDomain.run(domain, now, id);
      return queries.licenseById.get(id);
    },
    changeLicenseStatus(id, status, now) {
      queries.changeLicenseStatus.run(status, now, id);
      return queries.licenseById.get(id);
    },
  };
}

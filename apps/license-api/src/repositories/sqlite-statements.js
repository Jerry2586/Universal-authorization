export function createSqliteStatements(database) {
  return {
    insertProduct: database.prepare(`INSERT INTO products (id, code, name, created_at) VALUES (?, ?, ?, ?)`),
    productByCode: database.prepare(`SELECT * FROM products WHERE code = ?`),
    planByCode: database.prepare(`SELECT * FROM license_plans WHERE code = ?`),
    listPlans: database.prepare(`SELECT * FROM license_plans WHERE status = 'active' ORDER BY code ASC`),
    insertLicense: database.prepare(`
      INSERT INTO licenses (
        id, product_id, customer_ref, key_prefix, key_hash, key_encrypted, status, bound_domain,
        update_until, max_builds_per_day, max_activations, plan_id,
        entitlement_capabilities_json, entitlement_limits_json, generation, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `),
    licenseByHash: database.prepare(`
      SELECT licenses.*, products.code AS product_code, products.name AS product_name,
        license_plans.code AS plan_code, license_plans.name AS plan_name,
        licenses.entitlement_capabilities_json AS plan_capabilities_json,
        licenses.entitlement_limits_json AS plan_limits_json
      FROM licenses
      JOIN products ON products.id = licenses.product_id
      LEFT JOIN license_plans ON license_plans.id = licenses.plan_id
      WHERE licenses.key_hash = ?
    `),
    licenseById: database.prepare(`
      SELECT licenses.*, products.code AS product_code, products.name AS product_name,
        license_plans.code AS plan_code, license_plans.name AS plan_name,
        licenses.entitlement_capabilities_json AS plan_capabilities_json,
        licenses.entitlement_limits_json AS plan_limits_json
      FROM licenses
      JOIN products ON products.id = licenses.product_id
      LEFT JOIN license_plans ON license_plans.id = licenses.plan_id
      WHERE licenses.id = ?
    `),
    bindDomain: database.prepare(`UPDATE licenses SET bound_domain = ?, updated_at = ? WHERE id = ? AND bound_domain IS NULL`),
    rotateLicense: database.prepare(`UPDATE licenses SET key_prefix = ?, key_hash = ?, key_encrypted = ?, generation = generation + 1, updated_at = ? WHERE id = ?`),
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
    installWindowByBuildInstallation: database.prepare(`
      SELECT * FROM install_activation_windows WHERE build_id = ? AND installation_id = ?
    `),
    installWindowById: database.prepare(`SELECT * FROM install_activation_windows WHERE id = ?`),
    insertInstallWindow: database.prepare(`
      INSERT INTO install_activation_windows (
        id, build_id, installation_id, domain, token_hash, status, started_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
    `),
    consumeInstallWindow: database.prepare(`
      UPDATE install_activation_windows SET status = 'consumed', consumed_at = ?
      WHERE id = ? AND status = 'active' AND expires_at >= ?
    `),
    expireInstallWindow: database.prepare(`
      UPDATE install_activation_windows SET status = 'expired', expired_at = ?
      WHERE id = ? AND status = 'active' AND expires_at < ?
    `),
    insertInstallReceipt: database.prepare(`
      INSERT INTO install_receipts (
        id, license_id, build_id, receipt_secret_hash, domain, backend_origin,
        installation_id, status, generation, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unlocked', ?, ?)
    `),
    installReceiptById: database.prepare(`
      SELECT install_receipts.*, builds.package_id, builds.package_secret_hash, builds.version,
        builds.status AS build_status, licenses.status AS license_status,
        licenses.bound_domain, licenses.generation AS license_generation,
        products.code AS product_code
      FROM install_receipts
      JOIN builds ON builds.id = install_receipts.build_id
      JOIN licenses ON licenses.id = install_receipts.license_id
      JOIN products ON products.id = licenses.product_id
      WHERE install_receipts.id = ?
    `),
    activateInstallReceipt: database.prepare(`
      UPDATE install_receipts SET status = 'activated', activated_at = ?
      WHERE id = ? AND status = 'unlocked'
    `),
    markBuildUnlocked: database.prepare(`
      UPDATE builds SET status = 'package_unlocked' WHERE id = ? AND status = 'ready'
    `),
    insertActivation: database.prepare(`
      INSERT INTO activations (
        id, license_id, build_id, domain, backend_origin, installation_id, status, generation,
        refresh_secret_hash, last_seen_at, created_at, identity_mode, installation_public_key_fingerprint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    transitionActivationStatus: database.prepare(`
      UPDATE activations
      SET status = ?, revoked_at = CASE WHEN ? = 'active' THEN NULL ELSE ? END
      WHERE id = ? AND status = ?
    `),
    supersedeActivations: database.prepare(`
      UPDATE activations SET status = 'superseded', revoked_at = ?
      WHERE license_id = ? AND domain = ? AND backend_origin = ? AND installation_id = ? AND status = 'active'
    `),
    fenceActivationsByInstallation: database.prepare(`
      UPDATE activations SET status = 'fenced', revoked_at = ?
      WHERE license_id = ? AND installation_id = ? AND status = 'active'
    `),
    activationById: database.prepare(`
      SELECT activations.*, licenses.status AS license_status, licenses.generation AS license_generation,
        licenses.bound_domain, licenses.plan_id, builds.package_id, builds.version, builds.status AS build_status,
        products.code AS product_code, license_plans.code AS plan_code,
        licenses.entitlement_capabilities_json AS plan_capabilities_json,
        licenses.entitlement_limits_json AS plan_limits_json
      FROM activations
      JOIN licenses ON licenses.id = activations.license_id
      JOIN builds ON builds.id = activations.build_id
      JOIN products ON products.id = licenses.product_id
      LEFT JOIN license_plans ON license_plans.id = licenses.plan_id
      WHERE activations.id = ?
    `),
    updateActivationSeen: database.prepare(`UPDATE activations SET last_seen_at = ? WHERE id = ?`),
    recoverActivationCredentials: database.prepare(`
      UPDATE activations SET refresh_secret_hash = ?, recovered_at = ?, recovery_generation = recovery_generation + 1,
        last_seen_at = ? WHERE id = ? AND status = 'active'
    `),
    insertOfflineLicenseFile: database.prepare(`
      INSERT INTO offline_license_files (id, activation_id, token_hash, format_version, issued_at, expires_at)
      VALUES (?, ?, ?, 'offline-license-v1', ?, ?)
    `),
    activeActivationForEnvironment: database.prepare(`
      SELECT activations.id FROM activations
      JOIN licenses ON licenses.id = activations.license_id
      WHERE activations.license_id = ? AND activations.domain = ? AND activations.backend_origin = ?
        AND activations.installation_id = ? AND activations.status = 'active'
        AND activations.generation = licenses.generation
      LIMIT 1
    `),
    countActiveActivationsForLicense: database.prepare(`
      SELECT COUNT(*) AS count FROM activations
      JOIN licenses ON licenses.id = activations.license_id
      WHERE activations.license_id = ? AND activations.status = 'active'
        AND activations.generation = licenses.generation
    `),
    insertInstallationChallenge: database.prepare(`
      INSERT INTO installation_challenges (
        id, purpose, installation_id, public_key_fingerprint, context_hash, nonce, status, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'created', ?, ?)
    `),
    installationChallengeById: database.prepare(`SELECT * FROM installation_challenges WHERE id = ?`),
    consumeInstallationChallenge: database.prepare(`
      UPDATE installation_challenges SET status = 'consumed', consumed_at = ?
      WHERE id = ? AND status = 'created' AND expires_at >= ?
    `),
    upsertInstallationIdentity: database.prepare(`
      INSERT INTO installation_identities (
        installation_id, license_id, public_key_pem, public_key_fingerprint, status,
        ownership_generation, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(installation_id) DO UPDATE SET
        license_id = excluded.license_id,
        public_key_pem = excluded.public_key_pem,
        public_key_fingerprint = excluded.public_key_fingerprint,
        status = excluded.status,
        last_seen_at = excluded.last_seen_at,
        fenced_at = CASE WHEN excluded.status = 'active' THEN NULL ELSE installation_identities.fenced_at END,
        revoked_at = CASE WHEN excluded.status = 'active' THEN NULL ELSE installation_identities.revoked_at END
    `),
    installationIdentityById: database.prepare(`SELECT * FROM installation_identities WHERE installation_id = ?`),
    touchInstallationIdentity: database.prepare(`UPDATE installation_identities SET last_seen_at = ? WHERE installation_id = ? AND status = 'active'`),
    fenceInstallationIdentity: database.prepare(`
      UPDATE installation_identities SET status = 'fenced', fenced_at = ?, ownership_generation = ownership_generation + 1
      WHERE installation_id = ? AND status = 'active'
    `),
    activateInstallationIdentity: database.prepare(`
      UPDATE installation_identities SET status = 'active', fenced_at = NULL, revoked_at = NULL,
        ownership_generation = ownership_generation + 1, last_seen_at = ?
      WHERE installation_id = ? AND status IN ('candidate', 'fenced')
    `),
    revokeInstallationIdentity: database.prepare(`
      UPDATE installation_identities
      SET status = 'revoked', revoked_at = ?, fenced_at = COALESCE(fenced_at, ?),
        ownership_generation = ownership_generation + 1
      WHERE installation_id = ? AND status IN ('candidate', 'active')
    `),
    insertProductMigrationGrant: database.prepare(`
      INSERT INTO product_migration_grants (
        id, license_id, source_activation_id, source_installation_id, target_public_key_fingerprint, token_hash,
        status, expires_at, rollback_until, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'issued', ?, ?, ?)
    `),
    productMigrationGrantByHash: database.prepare(`SELECT * FROM product_migration_grants WHERE token_hash = ?`),
    consumeProductMigrationGrant: database.prepare(`
      UPDATE product_migration_grants SET status = 'consumed', consumed_at = ?
      WHERE id = ? AND status = 'issued' AND expires_at >= ?
    `),
    prepareProductMigrationGrant: database.prepare(`
      UPDATE product_migration_grants
      SET status = 'prepared', target_activation_id = ?, prepared_at = ?
      WHERE id = ? AND status = 'issued' AND expires_at >= ?
    `),
    completeProductMigrationGrant: database.prepare(`
      UPDATE product_migration_grants SET status = 'completed', committed_at = ?
      WHERE id = ? AND status = 'prepared' AND rollback_until >= ?
    `),
    rollbackProductMigrationGrant: database.prepare(`
      UPDATE product_migration_grants SET status = 'rolled_back', rolled_back_at = ?, rollback_reason = ?
      WHERE id = ? AND status IN ('prepared', 'completed') AND rollback_until >= ?
    `),
    revokeInstallReceiptsByLicense: database.prepare(`
      UPDATE install_receipts SET status = 'revoked', revoked_at = ? WHERE license_id = ? AND status = 'unlocked'
    `),
    revokeActivationsByLicense: database.prepare(`
      UPDATE activations SET status = 'revoked', revoked_at = ? WHERE license_id = ? AND status = 'active'
    `),
    insertDomainMigration: database.prepare(`
      INSERT INTO domain_migration_requests (
        id, license_id, previous_domain, requested_domain, status, reason, requested_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `),
    domainMigrationById: database.prepare(`
      SELECT domain_migration_requests.*, licenses.customer_ref, licenses.status AS license_status,
        licenses.bound_domain, licenses.generation, products.code AS product_code
      FROM domain_migration_requests
      JOIN licenses ON licenses.id = domain_migration_requests.license_id
      JOIN products ON products.id = licenses.product_id
      WHERE domain_migration_requests.id = ?
    `),
    pendingDomainMigrationByLicense: database.prepare(`
      SELECT * FROM domain_migration_requests WHERE license_id = ? AND status = 'pending' LIMIT 1
    `),
    latestApprovedDomainMigrationByLicense: database.prepare(`
      SELECT * FROM domain_migration_requests
      WHERE license_id = ? AND status = 'approved'
      ORDER BY reviewed_at DESC, requested_at DESC LIMIT 1
    `),
    listDomainMigrations: database.prepare(`
      SELECT domain_migration_requests.*, licenses.customer_ref, licenses.bound_domain, products.code AS product_code
      FROM domain_migration_requests
      JOIN licenses ON licenses.id = domain_migration_requests.license_id
      JOIN products ON products.id = licenses.product_id
      ORDER BY CASE domain_migration_requests.status WHEN 'pending' THEN 0 ELSE 1 END,
        domain_migration_requests.requested_at DESC LIMIT ?
    `),
    decideDomainMigration: database.prepare(`
      UPDATE domain_migration_requests SET status = ?, reviewed_at = ?, reviewed_by = ?, review_note = ?
      WHERE id = ? AND status = 'pending'
    `),
    insertAudit: database.prepare(`
      INSERT INTO audit_events (id, actor_type, actor_id, action, subject_type, subject_id, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertLicenseEvent: database.prepare(`
      INSERT INTO license_events (
        id, license_id, event_type, build_id, activation_id, installation_id, result, reason_code,
        actor_type, actor_id, request_ip, user_agent, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    listLicenseEvents: database.prepare(`SELECT * FROM license_events WHERE license_id = ? ORDER BY created_at DESC LIMIT ?`),
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
        release_notes, channel, release_kind, access_tier, min_xboard_version, min_upgrade_version,
        rollback_allowed, rollback_to, published_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        access_tier = ?, min_xboard_version = ?, min_upgrade_version = ?, rollback_allowed = ?, rollback_to = ?,
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
        license_plans.code AS plan_code, license_plans.name AS plan_name,
        licenses.entitlement_capabilities_json AS plan_capabilities_json,
        licenses.entitlement_limits_json AS plan_limits_json,
        (SELECT COUNT(*) FROM builds WHERE builds.license_id = licenses.id) AS build_count,
        (SELECT COUNT(*) FROM activations WHERE activations.license_id = licenses.id AND activations.status = 'active') AS active_activation_count
      FROM licenses
      JOIN products ON products.id = licenses.product_id
      LEFT JOIN license_plans ON license_plans.id = licenses.plan_id
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
    activeActivationByInstallation: database.prepare(`
      SELECT activations.*, builds.version FROM activations
      JOIN builds ON builds.id = activations.build_id
      WHERE activations.license_id = ? AND activations.installation_id = ? AND activations.status = 'active'
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
    adminByUsername: database.prepare(`SELECT * FROM admin_users WHERE username = ? AND deleted_at IS NULL`),
    adminById: database.prepare(`SELECT * FROM admin_users WHERE id = ?`),
    listAdmins: database.prepare(`SELECT * FROM admin_users WHERE deleted_at IS NULL ORDER BY is_owner DESC, created_at ASC`),
    updateAdminLogin: database.prepare(`UPDATE admin_users SET last_login_at = ?, last_login_ip = ?, updated_at = ? WHERE id = ?`),
    changeAdminStatus: database.prepare(`UPDATE admin_users SET status = ?, updated_at = ? WHERE id = ? AND is_owner = 0`),
    updateAdminPassword: database.prepare(`UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE id = ?`),
    softDeleteAdmin: database.prepare(`
      UPDATE admin_users
      SET deleted_username = username,
          username = username || '#deleted#' || id,
          status = 'deleted',
          deleted_at = ?,
          updated_at = ?
      WHERE id = ? AND is_owner = 0 AND deleted_at IS NULL
    `),
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
    insertSupportTicket: database.prepare(`
      INSERT INTO support_tickets (
        id, ticket_number, license_id, build_job_id, category, subject, priority, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `),
    supportTicketById: database.prepare(`
      SELECT support_tickets.*, licenses.customer_ref, licenses.key_prefix, licenses.bound_domain,
        build_jobs.requested_version AS build_version, build_jobs.status AS build_status,
        admin_users.display_name AS assigned_admin_name
      FROM support_tickets
      JOIN licenses ON licenses.id = support_tickets.license_id
      LEFT JOIN build_jobs ON build_jobs.id = support_tickets.build_job_id
      LEFT JOIN admin_users ON admin_users.id = support_tickets.assigned_admin_id
      WHERE support_tickets.id = ?
    `),
    listSupportTicketsByLicense: database.prepare(`
      SELECT support_tickets.*, build_jobs.requested_version AS build_version, build_jobs.status AS build_status,
        admin_users.display_name AS assigned_admin_name
      FROM support_tickets
      LEFT JOIN build_jobs ON build_jobs.id = support_tickets.build_job_id
      LEFT JOIN admin_users ON admin_users.id = support_tickets.assigned_admin_id
      WHERE support_tickets.license_id = ?
      ORDER BY support_tickets.updated_at DESC LIMIT ?
    `),
    listSupportTickets: database.prepare(`
      SELECT support_tickets.*, licenses.customer_ref, licenses.key_prefix, licenses.bound_domain,
        build_jobs.requested_version AS build_version, build_jobs.status AS build_status,
        admin_users.display_name AS assigned_admin_name
      FROM support_tickets
      JOIN licenses ON licenses.id = support_tickets.license_id
      LEFT JOIN build_jobs ON build_jobs.id = support_tickets.build_job_id
      LEFT JOIN admin_users ON admin_users.id = support_tickets.assigned_admin_id
      ORDER BY CASE support_tickets.status WHEN 'pending' THEN 0 WHEN 'processing' THEN 1 WHEN 'waiting_customer' THEN 2 ELSE 3 END,
        CASE support_tickets.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
        support_tickets.updated_at DESC LIMIT ?
    `),
    insertSupportMessage: database.prepare(`
      INSERT INTO support_messages (id, ticket_id, actor_type, actor_id, body, visibility, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    listSupportMessages: database.prepare(`
      SELECT support_messages.*, admin_users.display_name AS admin_name
      FROM support_messages
      LEFT JOIN admin_users ON support_messages.actor_type = 'admin' AND admin_users.id = support_messages.actor_id
      WHERE support_messages.ticket_id = ?
      ORDER BY support_messages.created_at ASC
    `),
    touchSupportTicket: database.prepare(`UPDATE support_tickets SET updated_at = ? WHERE id = ?`),
    updateSupportTicketStatus: database.prepare(`
      UPDATE support_tickets SET status = ?, updated_at = ?,
        resolved_at = CASE
          WHEN ? = 'resolved' THEN COALESCE(resolved_at, ?)
          WHEN ? IN ('pending', 'processing', 'waiting_customer') THEN NULL
          ELSE resolved_at
        END,
        closed_at = CASE WHEN ? = 'closed' THEN COALESCE(closed_at, ?) ELSE NULL END,
        closed_by_type = CASE WHEN ? = 'closed' THEN COALESCE(closed_by_type, ?) ELSE NULL END,
        closed_by_id = CASE WHEN ? = 'closed' THEN COALESCE(closed_by_id, ?) ELSE NULL END,
        close_reason = CASE WHEN ? = 'closed' THEN COALESCE(close_reason, ?) ELSE NULL END,
        reopened_at = CASE WHEN status = 'closed' AND ? <> 'closed' THEN ? ELSE reopened_at END,
        reopened_by = CASE WHEN status = 'closed' AND ? <> 'closed' THEN ? ELSE reopened_by END
      WHERE id = ?
    `),
    updateSupportTicketPriority: database.prepare(`UPDATE support_tickets SET priority = ?, updated_at = ? WHERE id = ?`),
    assignSupportTicket: database.prepare(`UPDATE support_tickets SET assigned_admin_id = ?, status = CASE WHEN status = 'pending' THEN 'processing' ELSE status END, updated_at = ? WHERE id = ?`),
    insertSupportAttachment: database.prepare(`
      INSERT INTO support_attachments (
        id, ticket_id, message_id, original_name, storage_ref, content_type, size_bytes, sha256,
        visibility, actor_type, actor_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    supportAttachmentById: database.prepare(`SELECT * FROM support_attachments WHERE id = ?`),
    listSupportAttachments: database.prepare(`SELECT * FROM support_attachments WHERE ticket_id = ? ORDER BY created_at ASC`),
    changeLicenseDomain: database.prepare(`
      UPDATE licenses SET bound_domain = ?, generation = generation + 1, updated_at = ? WHERE id = ?
    `),
    changeLicenseStatus: database.prepare(`UPDATE licenses SET status = ?, updated_at = ? WHERE id = ?`),
    changeLicensePlan: database.prepare(`
      UPDATE licenses
      SET plan_id = ?, entitlement_capabilities_json = ?, entitlement_limits_json = ?,
        max_builds_per_day = ?, max_activations = ?, generation = generation + 1, updated_at = ?
      WHERE id = ?
    `),
    markLicenseDeleting: database.prepare(`UPDATE licenses SET status = 'deleting', generation = generation + 1, updated_at = ? WHERE id = ? AND status <> 'deleting'`),
    licenseFileRefs: database.prepare(`
      SELECT artifact_ref AS storage_ref FROM build_jobs WHERE license_id = ? AND artifact_ref IS NOT NULL
      UNION SELECT upload_ref AS storage_ref FROM build_jobs WHERE license_id = ? AND upload_ref IS NOT NULL
      UNION SELECT support_attachments.storage_ref AS storage_ref
        FROM support_attachments JOIN support_tickets ON support_tickets.id = support_attachments.ticket_id
        WHERE support_tickets.license_id = ?
    `),
    insertErasureJob: database.prepare(`
      INSERT INTO erasure_jobs (id, license_id, status, requested_by, file_refs_json, created_at)
      VALUES (?, ?, 'pending', ?, ?, ?)
    `),
    erasureJobById: database.prepare(`SELECT * FROM erasure_jobs WHERE id = ?`),
    erasureJobByLicense: database.prepare(`SELECT * FROM erasure_jobs WHERE license_id = ? ORDER BY created_at DESC LIMIT 1`),
    listPendingErasureJobs: database.prepare(`SELECT * FROM erasure_jobs WHERE status IN ('pending', 'files_pending') ORDER BY created_at ASC`),
    updateErasureJob: database.prepare(`UPDATE erasure_jobs SET status = ?, error_message = ?, completed_at = ? WHERE id = ?`),
    deleteErasureJob: database.prepare(`DELETE FROM erasure_jobs WHERE id = ?`),
    insertErasureTombstone: database.prepare(`
      INSERT INTO erasure_tombstones (id, operation_id, deleted_at, execution_version, records_deleted, files_deleted, result)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    insertCleanupTask: database.prepare(`
      INSERT OR IGNORE INTO file_cleanup_tasks (id, operation_id, storage_ref, status, attempts, last_error, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', 1, ?, ?, ?)
    `),
    listPendingCleanupTasks: database.prepare(`
      SELECT * FROM file_cleanup_tasks WHERE status = 'pending' ORDER BY updated_at ASC LIMIT ?
    `),
    completeCleanupTask: database.prepare(`
      UPDATE file_cleanup_tasks SET status = 'completed', last_error = NULL, updated_at = ?, completed_at = ?
      WHERE id = ? AND status = 'pending'
    `),
    failCleanupTask: database.prepare(`
      UPDATE file_cleanup_tasks SET attempts = attempts + 1, last_error = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'
    `),
    countPendingCleanupTasks: database.prepare(`
      SELECT COUNT(*) AS count FROM file_cleanup_tasks WHERE operation_id = ? AND status = 'pending'
    `),
    completeErasureCleanup: database.prepare(`
      UPDATE erasure_tombstones SET result = 'completed'
      WHERE operation_id = ? AND result = 'completed_with_cleanup_pending'
        AND NOT EXISTS (
          SELECT 1 FROM file_cleanup_tasks WHERE operation_id = ? AND status = 'pending'
        )
    `),
    deleteCustomerSessionsByLicense: database.prepare(`DELETE FROM web_sessions WHERE actor_type = 'customer' AND actor_id = ?`),
    deleteSupportAttachmentsByLicense: database.prepare(`DELETE FROM support_attachments WHERE ticket_id IN (SELECT id FROM support_tickets WHERE license_id = ?)`),
    deleteSupportMessagesByLicense: database.prepare(`DELETE FROM support_messages WHERE ticket_id IN (SELECT id FROM support_tickets WHERE license_id = ?)`),
    deleteSupportTicketsByLicense: database.prepare(`DELETE FROM support_tickets WHERE license_id = ?`),
    deleteOfflineLicenseFilesByLicense: database.prepare(`
      DELETE FROM offline_license_files
      WHERE activation_id IN (SELECT id FROM activations WHERE license_id = ?)
    `),
    deleteActivationsByLicense: database.prepare(`DELETE FROM activations WHERE license_id = ?`),
    deleteInstallationChallengesByLicense: database.prepare(`
      DELETE FROM installation_challenges
      WHERE installation_id IN (SELECT installation_id FROM installation_identities WHERE license_id = ?)
    `),
    deleteProductMigrationGrantsByLicense: database.prepare(`DELETE FROM product_migration_grants WHERE license_id = ?`),
    deleteInstallationIdentitiesByLicense: database.prepare(`DELETE FROM installation_identities WHERE license_id = ?`),
    deleteInstallReceiptsByLicense: database.prepare(`DELETE FROM install_receipts WHERE license_id = ?`),
    deleteInstallKeysByLicense: database.prepare(`DELETE FROM install_keys WHERE build_id IN (SELECT id FROM builds WHERE license_id = ?)`),
    deleteInstallWindowsByLicense: database.prepare(`
      DELETE FROM install_activation_windows
      WHERE build_id IN (SELECT id FROM builds WHERE license_id = ?)
    `),
    deleteBuildJobsByLicense: database.prepare(`DELETE FROM build_jobs WHERE license_id = ?`),
    deleteBuildsByLicense: database.prepare(`DELETE FROM builds WHERE license_id = ?`),
    deleteBuildTicketsByLicense: database.prepare(`DELETE FROM build_tickets WHERE license_id = ?`),
    deleteDomainMigrationsByLicense: database.prepare(`DELETE FROM domain_migration_requests WHERE license_id = ?`),
    deleteLicenseEventsByLicense: database.prepare(`DELETE FROM license_events WHERE license_id = ?`),
    deleteAuditByLicense: database.prepare(`DELETE FROM audit_events WHERE (subject_type = 'license' AND subject_id = ?) OR (actor_type = 'customer' AND actor_id = ?)`),
    deleteLicense: database.prepare(`DELETE FROM licenses WHERE id = ?`),
  };
}

import { invariant } from '../../../packages/core/src/errors.js';
import { publicBuildJob } from '../../../packages/contracts/src/build-job.js';
import { transaction } from './database.js';

export function createPortalService({ database, repository, licenseService, operations, support, artifactStore, clock = () => new Date(), packageVersion = 'development' }) {
  function customerLicense(session) {
    const license = repository.licenseById(session.actor_id);
    invariant(license && license.status === 'active', 'LICENSE_INACTIVE', '授权已停用', 403);
    return license;
  }

  function processErasureJob(job) {
    let refs = [];
    try { refs = JSON.parse(job.file_refs_json ?? '[]'); } catch { refs = []; }
    const failedFiles = [];
    let filesDeleted = 0;
    for (const storageRef of [...new Set(Array.isArray(refs) ? refs : [])]) {
      try {
        artifactStore.remove(storageRef);
        filesDeleted += 1;
      } catch (error) {
        failedFiles.push({ storageRef, error: String(error?.message ?? error).slice(0, 1000) });
      }
    }
    const now = clock().toISOString();
    const recordsDeleted = transaction(database, () => {
      const deleted = repository.deleteLicenseGraph(job.license_id);
      repository.finishLicenseErasure({
        operationId: job.id, executionVersion: packageVersion, recordsDeleted: deleted,
        filesDeleted, failedFiles, now,
      });
      return deleted;
    });
    return {
      operation_id: job.id, deleted: true, records_deleted: recordsDeleted,
      files_deleted: filesDeleted, cleanup_pending: failedFiles.length,
    };
  }

  return {
    repository,
    deleteLicensePermanently({ licenseId, actorId }) {
      const license = repository.licenseById(licenseId);
      invariant(license, 'LICENSE_NOT_FOUND', '授权不存在', 404);
      invariant(!repository.erasureJobByLicense(licenseId), 'LICENSE_ERASURE_RUNNING', '授权正在永久删除', 409);
      const job = transaction(database, () => repository.beginLicenseErasure({
        licenseId, requestedBy: actorId, now: clock().toISOString(),
      }));
      return processErasureJob(job);
    },
    resumePendingErasures() {
      const results = [];
      for (const job of repository.listPendingErasureJobs()) {
        try { results.push(processErasureJob(job)); } catch (error) {
          repository.updateErasureJob(job.id, 'files_pending', String(error?.message ?? error).slice(0, 2000));
        }
      }
      return results;
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
        system_version: packageVersion,
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
          published_at: version.published_at ?? version.created_at,
          is_latest: version.version === latestVersion,
          is_current: version.version === currentVersion,
          eligible: !license.update_until || new Date(version.published_at ?? version.created_at) <= new Date(license.update_until),
        })),
        current_version: currentVersion,
        latest_version: latestVersion,
        builds: builds.map(publicBuildJob),
        tickets: support.listCustomerTickets(license.id),
      };
    },

    bindCustomerDomain(session, { domain }) {
      customerLicense(session);
      const license = licenseService.bindLicenseDomain({ licenseId: session.actor_id, domain, actorId: session.actor_id });
      return { bound_domain: license.bound_domain, generation: license.generation };
    },

    requestCustomerDomainMigration(session, { domain }) {
      customerLicense(session);
      const cooldownHours = Math.max(0, Number(repository.setting('domain_migration_cooldown_hours')) || 0);
      const result = licenseService.selfServiceDomainMigration({
        licenseId: session.actor_id, domain, reason: '', cooldownHours, actorId: session.actor_id,
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

    adminOverview() {
      const start = new Date(clock());
      start.setHours(0, 0, 0, 0);
      return {
        stats: repository.dashboardStats(start.toISOString()),
        license_plans: repository.listPlans().map((plan) => ({
          id: plan.id, code: plan.code, name: plan.name, status: plan.status,
          capabilities: JSON.parse(plan.capabilities_json ?? '[]'),
          limits: JSON.parse(plan.limits_json ?? '{}'),
        })),
        licenses: repository.listLicenses(100).map((license) => ({
          id: license.id,
          product: license.product_code,
          customer_ref: license.customer_ref,
          key_prefix: license.key_prefix,
          key_recoverable: Boolean(license.key_encrypted),
          status: license.status,
          bound_domain: license.bound_domain,
          update_until: license.update_until,
          max_builds_per_day: license.max_builds_per_day,
          max_activations: license.max_activations,
          plan_code: license.plan_code ?? 'legacy',
          plan_name: license.plan_name ?? '历史兼容版',
          capabilities: JSON.parse(license.plan_capabilities_json ?? '[]'),
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
          withdrawn_reason: version.withdrawn_reason,
          published_at: version.published_at,
          created_at: version.created_at,
        })),
        admins: repository.listAdmins().map((admin) => ({
          id: admin.id, username: admin.username, display_name: admin.display_name, role: admin.role,
          status: admin.status, is_owner: Boolean(admin.is_owner), last_login_at: admin.last_login_at,
          last_login_ip: admin.last_login_ip, created_at: admin.created_at,
        })),
        tickets: support.listAdminTickets(),
        cms: operations.cmsSettings(),
      };
    },

  };
}

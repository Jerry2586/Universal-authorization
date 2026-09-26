import { publicBuildJob } from '../../../../../packages/contracts/src/build-job.js';
import { startOfRollingDay } from '../shared/service-utils.js';

export function createAdminOverviewService({ repository, licensing, operations, support, clock = () => new Date() }) {
  return Object.freeze({
    reviewDomainMigration({ requestId, decision, reviewNote, actorId }) {
      const result = licensing.reviewDomainMigration({ requestId, decision, reviewNote, reviewerId: actorId });
      return {
        id: result.request.id, status: result.request.status, reviewed_at: result.request.reviewed_at,
        bound_domain: result.license.bound_domain, generation: result.license.generation,
      };
    },

    adminOverview(actorId) {
      const start = new Date(clock());
      start.setHours(0, 0, 0, 0);
      const rollingDay = startOfRollingDay(clock());
      return {
        stats: repository.dashboardStats(start.toISOString()),
        license_plans: repository.allPlans().map((plan) => ({
          id: plan.id, code: plan.code, name: plan.name, status: plan.status, access_tier: plan.access_tier,
          capabilities: JSON.parse(plan.capabilities_json ?? '[]'), limits: JSON.parse(plan.limits_json ?? '{}'),
        })),
        licenses: repository.listLicenses(100).map((license) => ({
          id: license.id, product: license.product_code, customer_ref: license.customer_ref,
          key_prefix: license.key_prefix, key_recoverable: Boolean(license.key_encrypted), status: license.status,
          bound_domain: license.bound_domain, update_until: license.update_until,
          max_builds_per_day: license.max_builds_per_day, max_activations: license.max_activations,
          max_builds_total: license.max_builds_total,
          plan_code: license.plan_code ?? 'legacy', plan_name: license.plan_name ?? '历史兼容版',
          capabilities: JSON.parse(license.plan_capabilities_json ?? '[]'),
          limits: JSON.parse(license.plan_limits_json ?? '{}'), generation: license.generation,
          build_count: license.build_count,
          builds_used_last_24_hours: repository.recentBuildCount(license.id, rollingDay),
          active_activation_count: license.active_activation_count,
          created_at: license.created_at,
        })),
        domain_migrations: repository.listDomainMigrations(100).map((request) => ({
          id: request.id, license_id: request.license_id, customer_ref: request.customer_ref,
          previous_domain: request.previous_domain, requested_domain: request.requested_domain,
          status: request.status, reason: request.reason, requested_at: request.requested_at,
          reviewed_at: request.reviewed_at, review_note: request.review_note,
        })),
        builds: repository.listBuildJobs(100).map(publicBuildJob),
        activations: repository.listActivations(100).map((activation) => ({
          id: activation.id, customer_ref: activation.customer_ref, product: activation.product_code,
          version: activation.version, domain: activation.domain, backend_origin: activation.backend_origin,
          installation_id: activation.installation_id, status: activation.status,
          last_seen_at: activation.last_seen_at, created_at: activation.created_at,
        })),
        audit: repository.listAudit(100),
        versions: repository.listSourceVersions('appgog').map((version) => ({
          id: version.id, version: version.version, display_name: version.display_name, status: version.status,
          source_kind: version.source_kind, release_notes: version.release_notes, channel: version.channel,
          release_kind: version.release_kind, access_tier: version.access_tier ?? 'free',
          min_xboard_version: version.min_xboard_version,
          min_upgrade_version: version.min_upgrade_version, withdrawn_reason: version.withdrawn_reason,
          published_at: version.published_at, created_at: version.created_at,
        })),
        admins: repository.listAdmins().map((admin) => ({
          id: admin.id, username: admin.username, display_name: admin.display_name, role: admin.role,
          status: admin.status, is_owner: Boolean(admin.is_owner), last_login_at: admin.last_login_at,
          last_login_ip: admin.last_login_ip, created_at: admin.created_at,
        })),
        tickets: support.listAdminTickets(actorId),
        cms: operations.cmsSettings(),
      };
    },
  });
}

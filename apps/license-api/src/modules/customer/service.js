import { publicBuildJob } from '../../../../../packages/contracts/src/build-job.js';
import { invariant } from '../../../../../packages/core/src/errors.js';

export function createCustomerPortalService({
  repository, licensing, support, clock = () => new Date(), packageVersion = 'development',
}) {
  function customerLicense(session) {
    const license = repository.licenseById(session.actor_id);
    invariant(license && license.status === 'active', 'LICENSE_INACTIVE', '授权已停用', 403);
    return license;
  }

  return Object.freeze({
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
      const announcementEnabled = repository.setting('announcement_enabled') === 'true'
        && Boolean(announcementTitle.trim() || announcementBody.trim());
      const buildsUsed = repository.recentBuildCount(
        license.id, new Date(clock().getTime() - 24 * 60 * 60 * 1000).toISOString(),
      );
      return {
        system_version: packageVersion,
        license: {
          product: license.product_code, key_prefix: license.key_prefix, status: license.status,
          bound_domain: license.bound_domain, update_until: license.update_until,
          max_builds_per_day: license.max_builds_per_day, builds_used_last_24_hours: buildsUsed,
          builds_remaining: Math.max(0, license.max_builds_per_day - buildsUsed), generation: license.generation,
        },
        domain_migration: migration ? {
          id: migration.id, previous_domain: migration.previous_domain,
          requested_domain: migration.requested_domain, status: migration.status, reason: migration.reason,
          requested_at: migration.requested_at, reviewed_at: migration.reviewed_at,
          cooldown_hours: cooldownHours, next_allowed_at: nextAllowedAt,
          cooldown_active: Boolean(nextAllowedAt && clock() < new Date(nextAllowedAt)),
        } : null,
        domain_migration_policy: {
          cooldown_hours: cooldownHours, next_allowed_at: nextAllowedAt,
          cooldown_active: Boolean(nextAllowedAt && clock() < new Date(nextAllowedAt)),
        },
        announcement: announcementEnabled ? {
          title: announcementTitle, body: announcementBody,
          published_at: repository.setting('announcement_published_at'),
        } : null,
        versions: versions.map((version) => ({
          version: version.version, display_name: version.display_name, source_kind: version.source_kind,
          release_notes: version.release_notes, channel: version.channel, release_kind: version.release_kind,
          min_xboard_version: version.min_xboard_version, min_upgrade_version: version.min_upgrade_version,
          published_at: version.published_at ?? version.created_at, is_latest: version.version === latestVersion,
          is_current: version.version === currentVersion,
          eligible: !license.update_until
            || new Date(version.published_at ?? version.created_at) <= new Date(license.update_until),
        })),
        current_version: currentVersion,
        latest_version: latestVersion,
        builds: builds.map(publicBuildJob),
        tickets: support.listCustomerTickets(license.id),
      };
    },

    bindCustomerDomain(session, { domain }) {
      customerLicense(session);
      const license = licensing.bindLicenseDomain({ licenseId: session.actor_id, domain, actorId: session.actor_id });
      return { bound_domain: license.bound_domain, generation: license.generation };
    },

    requestCustomerDomainMigration(session, { domain }) {
      customerLicense(session);
      const cooldownHours = Math.max(0, Number(repository.setting('domain_migration_cooldown_hours')) || 0);
      const result = licensing.selfServiceDomainMigration({
        licenseId: session.actor_id, domain, reason: '', cooldownHours, actorId: session.actor_id,
      });
      return {
        id: result.request.id, previous_domain: result.request.previous_domain,
        requested_domain: result.request.requested_domain, status: result.request.status,
        requested_at: result.request.requested_at, reviewed_at: result.request.reviewed_at,
        bound_domain: result.license.bound_domain, generation: result.license.generation,
      };
    },
  });
}

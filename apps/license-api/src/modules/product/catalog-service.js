import { signCompactToken } from '../../../../../packages/core/src/signing.js';
import { iso } from '../shared/service-utils.js';

export function createProductCatalogService({
  repository, config, notificationPrivateKey, clock = () => new Date(),
}) {
  return Object.freeze({
    ensureProduct({ code = 'appgog', name = 'APPGOG' } = {}) {
      const normalized = code.trim().toLowerCase();
      return repository.productByCode(normalized)
        ?? repository.createProduct({ code: normalized, name, now: iso(clock) });
    },
    releaseAnnouncement(productCode = 'appgog') {
      const latest = repository.listActiveSourceVersions(productCode)[0] ?? null;
      if (!latest) return { latest: null, release_token: null, build_center_url: config.buildCenterPublicUrl ?? null };
      const release = {
        version: latest.version, display_name: latest.display_name, release_notes: latest.release_notes,
        published_at: latest.published_at ?? latest.created_at, channel: latest.channel, release_kind: latest.release_kind,
      };
      const now = clock();
      return {
        latest: release,
        build_center_url: config.buildCenterPublicUrl ?? null,
        release_token: signCompactToken({
          iss: config.publicBaseUrl, typ: 'release', product: productCode, ...release,
          build_center_url: config.buildCenterPublicUrl ?? null,
          iat: Math.floor(now.getTime() / 1000), exp: Math.floor(now.getTime() / 1000) + 86400,
        }, notificationPrivateKey),
      };
    },
  });
}

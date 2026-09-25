import { createAdminOverviewService } from './modules/admin/overview-service.js';
import { createCustomerPortalService } from './modules/customer/service.js';
import { createLicenseErasureService } from './modules/licensing/erasure-service.js';

export function createPortalService({
  database, repositories, licensing, entitlementAccess, operations, support, artifactStore,
  clock = () => new Date(), packageVersion = 'development',
}) {
  const customer = createCustomerPortalService({
    repository: repositories.customer, licensing, entitlementAccess, support, clock, packageVersion,
  });
  const admin = createAdminOverviewService({
    repository: repositories.adminOverview, licensing, operations, support, clock,
  });
  const erasure = createLicenseErasureService({
    database, repository: repositories.erasure, artifactStore, clock, packageVersion,
  });
  return Object.freeze({ ...customer, ...admin, ...erasure });
}

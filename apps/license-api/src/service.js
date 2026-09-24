import { createActivationService } from './modules/activation/service.js';
import { createAuditService } from './modules/audit/service.js';
import { createEntitlementService } from './modules/entitlement/service.js';
import { createLicensingService } from './modules/licensing/service.js';
import { createBuildAuthorizationService } from './modules/packaging/authorization-service.js';
import { createProductCatalogService } from './modules/product/catalog-service.js';

export function createLicenseService({
  database, repositories, config, privateKey,
  activationPrivateKey = privateKey, packagePrivateKey = privateKey, notificationPrivateKey = privateKey,
  clock = () => new Date(),
}) {
  const audit = createAuditService({ repository: repositories.audit });
  const { listLicenseEvents } = audit;
  const productCatalog = createProductCatalogService({
    repository: repositories.productCatalog, config, notificationPrivateKey, clock,
  });
  const activation = createActivationService({
    database, repository: repositories.activation, audit, config, activationPrivateKey, clock,
  });
  const { internal: activationLifecycle, ...activationPublic } = activation;
  const licensing = createLicensingService({
    database, repository: repositories.licensing, productCatalog, activationLifecycle, audit, config, clock,
  });
  const { internal: licensingAccess, ...licensingPublic } = licensing;
  const entitlement = createEntitlementService({
    database, repository: repositories.entitlement, activationLifecycle, audit, clock,
  });
  const buildAuthorization = createBuildAuthorizationService({
    database, repository: repositories.buildAuthorization, licensingAccess, audit, config, packagePrivateKey, clock,
  });

  return Object.freeze({
    ...productCatalog,
    ...licensingPublic,
    ...entitlement,
    ...buildAuthorization,
    ...activationPublic,
    listLicenseEvents,
  });
}

import { signCompactToken } from '../../../packages/core/src/signing.js';
import { transaction } from './database.js';
import { createBridgeUpdates } from './modules/operations/bridge-updates.js';
import { createBridgeDistribution } from '../../../packages/adapters/src/bridge-distribution.js';
import { createXboardBridgePackage, xboardBridgeDescriptor } from '../../build-worker/src/xboard-bridge-package.js';
import { createBridgeReleaseSource } from '../../../packages/adapters/src/bridge-release-source.js';
import { createRepository } from './repository.js';
import { createLicenseService } from './service.js';
import { createSessionService } from './session-service.js';
import { createPortalService } from './portal-service.js';
import { SqliteBuildQueue } from '../../../packages/adapters/src/sqlite-build-queue.js';
import { LocalArtifactStore } from '../../../packages/adapters/src/local-artifact-store.js';
import { HardenedThemeBuildEngine } from '../../build-worker/src/engine.js';
import { hashPassword } from '../../../packages/core/src/password.js';
import { createUpdateControl } from './update-control.js';
import { createMigrationControl } from './modules/migration/control.js';
import { createControlMigrationRepository } from './modules/migration/repository.js';
import { createIdentityRepositoryPort } from './modules/identity/repository-port.js';
import { createSessionRepositoryPort } from './modules/identity/session-repository-port.js';
import { createIdentityService } from './modules/identity/service.js';
import { createAdminOverviewRepositoryPort } from './modules/admin/overview-repository-port.js';
import { createActivationRepositoryPort } from './modules/activation/repository-port.js';
import { createAuditRepositoryPort } from './modules/audit/repository-port.js';
import { createCustomerPortalRepositoryPort } from './modules/customer/repository-port.js';
import { createEntitlementRepositoryPort } from './modules/entitlement/repository-port.js';
import { createLicenseErasureRepositoryPort } from './modules/licensing/erasure-repository-port.js';
import { createLicensingRepositoryPort } from './modules/licensing/repository-port.js';
import { createOperationsRepositoryPort } from './modules/operations/repository-port.js';
import { createOperationsService } from './modules/operations/service.js';
import { createSupportRepositoryPort } from './modules/support/repository-port.js';
import { createSupportService } from './modules/support/service.js';
import { createPackagingRepositoryPort } from './modules/packaging/repository-port.js';
import { createBuildAuthorizationRepositoryPort } from './modules/packaging/authorization-repository-port.js';
import { createPackagingService } from './modules/packaging/service.js';
import { createProductRepositoryPort } from './modules/product/repository-port.js';
import { createProductCatalogRepositoryPort } from './modules/product/catalog-repository-port.js';
import { createProductManagementService } from './modules/product/management-service.js';
import { createProductManagementRepositoryPort } from './modules/product/management-repository-port.js';
import { createProductService } from './modules/product/service.js';
import { PACKAGE_VERSION } from '../../../packages/core/src/version.js';


export function bootstrap({ database, config, privateKey, publicKey = '', keyring = null, clock }) {
  const signingKeys = keyring ?? {
    activation: { privateKey, publicKey },
    package: { privateKey, publicKey },
    notification: { privateKey, publicKey },
  };
  const repository = createRepository(database);
  const migrationRepository = createControlMigrationRepository(database);
  const service = createLicenseService({
    database,
    repositories: Object.freeze({
      activation: createActivationRepositoryPort(repository),
      audit: createAuditRepositoryPort(repository),
      buildAuthorization: createBuildAuthorizationRepositoryPort(repository),
      entitlement: createEntitlementRepositoryPort(repository),
      licensing: createLicensingRepositoryPort(repository),
      productCatalog: createProductCatalogRepositoryPort(repository),
    }),
    config,
    activationPrivateKey: signingKeys.activation.privateKey,
    packagePrivateKey: signingKeys.package.privateKey,
    notificationPrivateKey: signingKeys.notification.privateKey,
    clock,
  });
  const queue = new SqliteBuildQueue({ database, repository, clock });
  const artifactStore = new LocalArtifactStore(config.artifactRoot ?? './var/artifacts');
  const bridgeDistribution = createBridgeDistribution({ root: artifactStore.root, bundled: () => ({
    buffer: createXboardBridgePackage(), descriptor: xboardBridgeDescriptor(), version: xboardBridgeDescriptor().version, release_version: PACKAGE_VERSION,
  }) });
  const buildEngine = new HardenedThemeBuildEngine({
    bridgePackage: () => bridgeDistribution.snapshot(),
    artifactStore,
    publicKey: signingKeys.package.publicKey,
    activationPublicKey: signingKeys.activation.publicKey,
    packagePublicKey: signingKeys.package.publicKey,
    notificationPublicKey: signingKeys.notification.publicKey,
    publicBaseUrl: config.publicBaseUrl,
  });
  const sessions = createSessionService({ repository: createSessionRepositoryPort(repository), config, clock });
  const updates = createUpdateControl({ root: config.updateControlPath, currentVersion: PACKAGE_VERSION, clock });
  const bridgeUpdates = createBridgeUpdates({
    distribution: bridgeDistribution, releases: createBridgeReleaseSource(),
    packagePrivateKey: signingKeys.package.privateKey, issuer: config.publicBaseUrl,
    repository: createOperationsRepositoryPort(repository), atomic: fn => transaction(database, fn), clock,
  });
  const identity = createIdentityService({ repository: createIdentityRepositoryPort(repository), clock });
  const operations = createOperationsService({
    repository: createOperationsRepositoryPort(repository), config, packageVersion: PACKAGE_VERSION, clock,
  });
  const support = createSupportService({
    database, repository: createSupportRepositoryPort(repository), artifactStore, clock,
  });
  const packaging = createPackagingService({
    database,
    repository: createPackagingRepositoryPort(repository), queue,
    buildAuthorization: Object.freeze({ claimBuildForJob: service.claimBuildForJob }),
    entitlementAccess: Object.freeze({
      assertVersionAccess: service.assertVersionAccess,
      versionEligibility: service.versionEligibility,
    }),
    operations, artifactStore, buildEngine, config, clock,
    signContent: claims => signCompactToken(claims, signingKeys.package.privateKey),
  });
  const productManagement = createProductManagementService({
    repository: createProductManagementRepositoryPort(repository), atomic: fn => transaction(database, fn), clock,
  });
  const product = createProductService({
    repository: createProductRepositoryPort(repository),
    atomic: operation => transaction(database, operation),
    entitlementAccess: Object.freeze({ validateReleasePlans: service.validateReleasePlans }),
    productCatalog: Object.freeze({ ensureProduct: service.ensureProduct }),
    artifactStore, buildEngine, config, clock,
  });
  const migrations = createMigrationControl({
    repository: migrationRepository,
    audit: (event) => repository.audit(event),
    config: { ...config, packageVersion: PACKAGE_VERSION },
    root: config.updateControlPath,
    clock,
  });
  const portalCore = createPortalService({
    database,
    repositories: Object.freeze({
      adminOverview: createAdminOverviewRepositoryPort(repository),
      customer: createCustomerPortalRepositoryPort(repository),
      erasure: createLicenseErasureRepositoryPort(repository),
    }),
    licensing: Object.freeze({
      bindLicenseDomain: service.bindLicenseDomain,
      reviewDomainMigration: service.reviewDomainMigration,
      selfServiceDomainMigration: service.selfServiceDomainMigration,
    }),
    entitlementAccess: Object.freeze({ versionEligibility: service.versionEligibility }),
    operations, support, artifactStore, clock,
    packageVersion: PACKAGE_VERSION,
  });
  const portal = Object.freeze({ ...portalCore, ...identity, ...operations, ...support, ...packaging, ...product, ...productManagement });
  service.ensureProduct({ code: 'appgog', name: 'APPGOG' });
  const adminUsername = config.adminUsername ?? 'admin';
  const adminPassword = config.adminPassword ?? 'appgog-development-admin';
  if (!repository.adminByUsername(adminUsername)) {
    repository.createAdmin({
      username: adminUsername,
      displayName: '平台所有者',
      role: 'owner',
      isOwner: true,
      passwordHash: hashPassword(adminPassword),
      now: (clock ? clock() : new Date()).toISOString(),
    });
  }
  portal.resumePendingErasures();
  return { repository, service, sessions, portal, updates, bridgeUpdates, migrations, queue, artifactStore, buildEngine };
}

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
import { createProductService } from './modules/product/service.js';
import { readFileSync } from 'node:fs';

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;

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
  const buildEngine = new HardenedThemeBuildEngine({
    artifactStore,
    publicKey: signingKeys.package.publicKey,
    activationPublicKey: signingKeys.activation.publicKey,
    packagePublicKey: signingKeys.package.publicKey,
    notificationPublicKey: signingKeys.notification.publicKey,
    publicBaseUrl: config.publicBaseUrl,
  });
  const sessions = createSessionService({ repository: createSessionRepositoryPort(repository), config, clock });
  const updates = createUpdateControl({ root: config.updateControlPath, currentVersion: PACKAGE_VERSION, clock });
  const identity = createIdentityService({ repository: createIdentityRepositoryPort(repository), clock });
  const operations = createOperationsService({
    repository: createOperationsRepositoryPort(repository), config, packageVersion: PACKAGE_VERSION, clock,
  });
  const support = createSupportService({
    database, repository: createSupportRepositoryPort(repository), artifactStore, clock,
  });
  const packaging = createPackagingService({
    repository: createPackagingRepositoryPort(repository), queue,
    buildAuthorization: Object.freeze({ claimBuildForJob: service.claimBuildForJob }),
    operations, artifactStore, buildEngine, config, clock,
  });
  const product = createProductService({
    repository: createProductRepositoryPort(repository),
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
    operations, support, artifactStore, clock,
    packageVersion: PACKAGE_VERSION,
  });
  const portal = Object.freeze({ ...portalCore, ...identity, ...operations, ...support, ...packaging, ...product });
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
  return { repository, service, sessions, portal, updates, migrations, queue, artifactStore, buildEngine };
}

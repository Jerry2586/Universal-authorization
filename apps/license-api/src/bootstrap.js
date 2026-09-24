import { createRepository } from './repository.js';
import { createLicenseService } from './service.js';
import { createSessionService } from './session-service.js';
import { createPortalService } from './portal-service.js';
import { SqliteBuildQueue } from '../../../packages/adapters/src/sqlite-build-queue.js';
import { LocalArtifactStore } from '../../../packages/adapters/src/local-artifact-store.js';
import { HardenedThemeBuildEngine } from '../../build-worker/src/engine.js';
import { hashPassword } from '../../../packages/core/src/password.js';
import { createUpdateControl } from './update-control.js';
import { readFileSync } from 'node:fs';

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;

export function bootstrap({ database, config, privateKey, publicKey = '', clock }) {
  const repository = createRepository(database);
  const service = createLicenseService({ database, repository, config, privateKey, clock });
  const queue = new SqliteBuildQueue({ database, repository, clock });
  const artifactStore = new LocalArtifactStore(config.artifactRoot ?? './var/artifacts');
  const buildEngine = new HardenedThemeBuildEngine({
    artifactStore,
    publicKey,
    publicBaseUrl: config.publicBaseUrl,
  });
  const sessions = createSessionService({ repository, config, clock });
  const updates = createUpdateControl({ root: config.updateControlPath, currentVersion: PACKAGE_VERSION, clock });
  const portal = createPortalService({
    repository, queue, licenseService: service, artifactStore, buildEngine, config, clock, packageVersion: PACKAGE_VERSION,
  });
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
  return { repository, service, sessions, portal, updates, queue, artifactStore, buildEngine };
}

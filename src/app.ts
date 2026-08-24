import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { ChallengeService, type Clock } from './modules/challenges/challenge.service.js';
import type { ChallengeStore } from './modules/challenges/challenge.store.js';
import { registerChallengeRoutes } from './modules/challenges/challenge.routes.js';
import { InMemoryChallengeStore } from './modules/challenges/infrastructure/in-memory-challenge.store.js';
import { registerHealthRoutes } from './modules/health/health.routes.js';
import { registerManagementRoutes, type ManagementRouteDependencies } from './modules/management/management.routes.js';
import type { ReadinessCheck } from './shared/health/readiness.js';
import { registerErrorHandler } from './shared/http/error-handler.js';
import { ActivationService, type ActivationServiceOptions } from './modules/activations/activation.service.js';
import type { ActivationRepository } from './modules/activations/activation.repository.js';
import type { ActivationIdempotencyStore } from './modules/activations/activation-idempotency.store.js';
import type { LicenseKeyCodec } from './modules/licenses/license-key-codec.js';
import type { Ed25519DeviceSignatureVerifier } from './modules/cryptography/ed25519-device-signature-verifier.js';
import type { CompactTokenIssuer } from './modules/cryptography/compact-token-issuer.js';
import { registerActivationRoutes } from './modules/activations/activation.routes.js';
import type { CompactTokenVerifier } from './modules/cryptography/compact-token-verifier.js';
import type { RequestReplayStore } from './modules/security/request-replay.store.js';
import type { LicenseRuntimeRepository } from './modules/verification/license-runtime.repository.js';
import { DeviceRequestAuthenticator, type DeviceRequestAuthenticatorOptions } from './modules/verification/device-request-authenticator.js';
import { LicenseVerificationService } from './modules/verification/license-verification.service.js';
import type { LicenseRefreshIdempotencyStore } from './modules/refresh/license-refresh-idempotency.store.js';
import { LicenseRefreshService, type LicenseRefreshServiceOptions } from './modules/refresh/license-refresh.service.js';
import { registerVerificationRoutes } from './modules/verification/verification.routes.js';
import type { OnlineSessionStore } from './modules/sessions/online-session.store.js';
import type { SessionActionIdempotencyStore } from './modules/session-actions/session-action-idempotency.store.js';
import { SessionHeartbeatService, type SessionHeartbeatServiceOptions } from './modules/sessions/session-heartbeat.service.js';
import { SessionReleaseService } from './modules/sessions/session-release.service.js';
import { DeviceUnbindService } from './modules/devices/device-unbind.service.js';
import { registerSessionLifecycleRoutes } from './modules/sessions/session-lifecycle.routes.js';
import { registerAdminDeviceRoutes, type AdminDeviceRouteDependencies } from './modules/admin-devices/admin-device.routes.js';
import { registerAdminAuditRoutes, type AdminAuditRouteDependencies } from './modules/admin-audit/admin-audit.routes.js';

export interface ActivationModuleDependencies {
  repository: ActivationRepository;
  idempotency: ActivationIdempotencyStore;
  keyCodec: LicenseKeyCodec;
  signatureVerifier: Ed25519DeviceSignatureVerifier;
  tokenIssuer: CompactTokenIssuer;
  options: ActivationServiceOptions;
}

export interface LicenseRuntimeModuleDependencies {
  repository: LicenseRuntimeRepository;
  refreshIdempotency: LicenseRefreshIdempotencyStore;
  replayStore: RequestReplayStore;
  signatureVerifier: Ed25519DeviceSignatureVerifier;
  tokenVerifier: CompactTokenVerifier;
  tokenIssuer: CompactTokenIssuer;
  authenticatorOptions: DeviceRequestAuthenticatorOptions;
  refreshOptions: LicenseRefreshServiceOptions;
  onlineSessionStore?: OnlineSessionStore;
  sessionActionIdempotency?: SessionActionIdempotencyStore;
  sessionHeartbeatOptions?: SessionHeartbeatServiceOptions;
  sessionActionIdempotencyTtlSeconds?: number;
}

export interface BuildAppOptions {
  logger?: boolean | FastifyBaseLogger;
  challengeStore?: ChallengeStore;
  challengeTtlSeconds?: number;
  clock?: Clock;
  readinessCheck?: ReadinessCheck;
  management?: ManagementRouteDependencies;
  adminDevices?: AdminDeviceRouteDependencies;
  adminAudit?: AdminAuditRouteDependencies;
  activation?: ActivationModuleDependencies;
  licenseRuntime?: LicenseRuntimeModuleDependencies;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false, requestIdHeader: 'x-request-id' });
  const challengeStore = options.challengeStore ?? new InMemoryChallengeStore();
  const challengeService = new ChallengeService(challengeStore, options.challengeTtlSeconds ?? 120, options.clock);

  registerErrorHandler(app);
  registerHealthRoutes(app, options.readinessCheck);
  registerChallengeRoutes(app, challengeService);
  if (options.management !== undefined) registerManagementRoutes(app, options.management);
  if (options.adminDevices !== undefined) registerAdminDeviceRoutes(app, options.adminDevices);
  if (options.adminAudit !== undefined) registerAdminAuditRoutes(app, options.adminAudit);
  if (options.activation !== undefined) {
    const service = new ActivationService(
      challengeService,
      options.activation.repository,
      options.activation.idempotency,
      options.activation.keyCodec,
      options.activation.signatureVerifier,
      options.activation.tokenIssuer,
      options.activation.options,
      options.clock,
    );
    registerActivationRoutes(app, service);
  }
  if (options.licenseRuntime !== undefined) {
    const authenticator = new DeviceRequestAuthenticator(
      options.licenseRuntime.tokenVerifier,
      options.licenseRuntime.signatureVerifier,
      options.licenseRuntime.repository,
      options.licenseRuntime.replayStore,
      options.licenseRuntime.authenticatorOptions,
      options.clock,
    );
    const verificationService = new LicenseVerificationService(
      authenticator,
      options.licenseRuntime.repository,
      options.licenseRuntime.refreshOptions.refreshAfterSeconds,
      options.clock,
    );
    const refreshService = new LicenseRefreshService(
      authenticator,
      options.licenseRuntime.repository,
      options.licenseRuntime.refreshIdempotency,
      options.licenseRuntime.tokenIssuer,
      options.licenseRuntime.refreshOptions,
      options.clock,
    );
    registerVerificationRoutes(app, verificationService, refreshService);
    if (
      options.licenseRuntime.onlineSessionStore !== undefined &&
      options.licenseRuntime.sessionActionIdempotency !== undefined &&
      options.licenseRuntime.sessionHeartbeatOptions !== undefined &&
      options.licenseRuntime.sessionActionIdempotencyTtlSeconds !== undefined
    ) {
      const heartbeatService = new SessionHeartbeatService(
        authenticator,
        options.licenseRuntime.repository,
        options.licenseRuntime.onlineSessionStore,
        options.licenseRuntime.sessionHeartbeatOptions,
        options.clock,
      );
      const releaseService = new SessionReleaseService(
        authenticator,
        options.licenseRuntime.repository,
        options.licenseRuntime.sessionActionIdempotency,
        options.licenseRuntime.onlineSessionStore,
        options.licenseRuntime.sessionActionIdempotencyTtlSeconds,
        options.clock,
      );
      const unbindService = new DeviceUnbindService(
        authenticator,
        options.licenseRuntime.repository,
        options.licenseRuntime.sessionActionIdempotency,
        options.licenseRuntime.onlineSessionStore,
        options.licenseRuntime.sessionActionIdempotencyTtlSeconds,
        options.clock,
      );
      registerSessionLifecycleRoutes(app, heartbeatService, releaseService, unbindService);
    }
  }
  return app;
}





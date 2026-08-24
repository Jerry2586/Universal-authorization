import { buildApp } from './app.js';
import { loadConfig, loadLocalEnvFile } from './config/env.js';
import { RuntimeInfrastructure } from './infrastructure/runtime/runtime-infrastructure.js';
import { ProductManagementService } from './modules/products/product-management.service.js';
import { LicenseManagementService } from './modules/licenses/license-management.service.js';
import { HmacLicenseKeyCodec } from './modules/licenses/license-key-codec.js';
import { Ed25519DeviceSignatureVerifier } from './modules/cryptography/ed25519-device-signature-verifier.js';
import { Ed25519FileSigningKeyProvider } from './modules/cryptography/ed25519-file-signing-key-provider.js';
import { CompactTokenIssuer } from './modules/cryptography/compact-token-issuer.js';
import { CompactTokenVerifier } from './modules/cryptography/compact-token-verifier.js';
import { AdminDeviceManagementService } from './modules/admin-devices/admin-device-management.service.js';
import { AdminAuditQueryService } from './modules/admin-audit/admin-audit-query.service.js';

loadLocalEnvFile();
const config = loadConfig();
let appLogger: ReturnType<typeof buildApp>['log'] | undefined;
const infrastructure = new RuntimeInfrastructure(config, (component, error) => {
  appLogger?.error({ component, error }, 'Infrastructure client error');
});
const productService = new ProductManagementService(infrastructure.productRepository, infrastructure.auditLog);
const keyCodec = new HmacLicenseKeyCodec(config.licenseKeyPepper);
const licenseService = new LicenseManagementService(infrastructure.licenseRepository, keyCodec, infrastructure.auditLog);
const adminDeviceService = new AdminDeviceManagementService(
  infrastructure.adminDeviceRepository,
  infrastructure.auditLog,
  infrastructure.onlineSessionStore,
);
const adminAuditQueryService = new AdminAuditQueryService(
  infrastructure.adminAuditQueryRepository,
  infrastructure.auditLog,
);
const signingProvider = new Ed25519FileSigningKeyProvider(
  config.licenseSigningKeyId,
  config.licenseSigningPrivateKeyPemBase64,
);
const signatureVerifier = new Ed25519DeviceSignatureVerifier();
const tokenIssuer = new CompactTokenIssuer(signingProvider);
const app = buildApp({
  logger: true,
  challengeStore: infrastructure.challengeStore,
  challengeTtlSeconds: config.challengeTtlSeconds,
  readinessCheck: () => infrastructure.readiness(),
  management: {
    principalResolver: infrastructure.adminPrincipalResolver,
    productService,
    licenseService,
  },
  adminDevices: {
    principalResolver: infrastructure.adminPrincipalResolver,
    deviceService: adminDeviceService,
  },
  adminAudit: {
    principalResolver: infrastructure.adminPrincipalResolver,
    auditQueryService: adminAuditQueryService,
  },
  activation: {
    repository: infrastructure.activationRepository,
    idempotency: infrastructure.activationIdempotencyStore,
    keyCodec,
    signatureVerifier,
    tokenIssuer,
    options: {
      requestMaxSkewSeconds: config.activationRequestMaxSkewSeconds,
      tokenTtlSeconds: config.licenseTokenTtlSeconds,
      certificateTtlSeconds: config.deviceCertificateTtlSeconds,
      idempotencyTtlSeconds: config.activationIdempotencyTtlSeconds,
      heartbeatIntervalSeconds: config.heartbeatIntervalSeconds,
      refreshAfterSeconds: config.refreshAfterSeconds,
      issuer: config.licenseTokenIssuer,
    },
  },
  licenseRuntime: {
    repository: infrastructure.licenseRuntimeRepository,
    refreshIdempotency: infrastructure.licenseRefreshIdempotencyStore,
    replayStore: infrastructure.requestReplayStore,
    signatureVerifier,
    tokenVerifier: new CompactTokenVerifier(signingProvider),
    tokenIssuer,
    authenticatorOptions: {
      issuer: config.licenseTokenIssuer,
      requestMaxSkewSeconds: config.licenseRequestMaxSkewSeconds,
      replayTtlSeconds: config.requestReplayTtlSeconds,
    },
    onlineSessionStore: infrastructure.onlineSessionStore,
    sessionActionIdempotency: infrastructure.sessionActionIdempotencyStore,
    sessionActionIdempotencyTtlSeconds: config.sessionActionIdempotencyTtlSeconds,
    sessionHeartbeatOptions: {
      heartbeatIntervalSeconds: config.heartbeatIntervalSeconds,
      onlineTtlSeconds: config.sessionOnlineTtlSeconds,
      refreshAfterSeconds: config.refreshAfterSeconds,
    },
    refreshOptions: {
      tokenTtlSeconds: config.licenseTokenTtlSeconds,
      idempotencyTtlSeconds: config.licenseRefreshIdempotencyTtlSeconds,
      heartbeatIntervalSeconds: config.heartbeatIntervalSeconds,
      refreshAfterSeconds: config.refreshAfterSeconds,
      issuer: config.licenseTokenIssuer,
    },
  },
});
appLogger = app.log;
let shuttingDown = false;

const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'Stopping license server');
  await app.close();
  await infrastructure.close();
  process.exit(0);
};
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

try {
  await infrastructure.connect();
  await app.listen({ host: config.host, port: config.port });
  app.log.info({ host: config.host, port: config.port, environment: config.nodeEnv }, 'License server started');
} catch (error) {
  app.log.error({ error }, 'License server failed to start');
  await infrastructure.close();
  process.exit(1);
}





import { resolve } from 'node:path';
import { loadLocalEnvironment } from '../../../packages/core/src/environment.js';
export { loadLocalEnvironment } from '../../../packages/core/src/environment.js';

function integer(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} 必须为正整数`);
  return value;
}

function boolean(name, fallback = true) {
  const value = String(process.env[name] ?? fallback).trim().toLowerCase();
  if (!['true', 'false'].includes(value)) throw new Error(`${name} 必须为 true 或 false`);
  return value === 'true';
}

export function loadConfig(overrides = {}) {
  loadLocalEnvironment();
  const cwd = process.cwd();
  const legacySurface = overrides.surface ?? process.env.APPGOG_SURFACE ?? null;
  const selectedRole = overrides.role ?? process.env.APPGOG_ROLE
    ?? (legacySurface === 'license-center' ? 'license-center' : 'all-in-one');
  const port = overrides.port ?? Number(process.env.PORT ?? 8787);
  const buildPort = Number(process.env.BUILD_CENTER_PORT ?? 8788);
  for (const [name, value] of [['PORT', port], ['BUILD_CENTER_PORT', buildPort]]) {
    if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(name + ' 必须为 1–65535 的整数');
  }
  const publicBaseUrl = overrides.publicBaseUrl ?? process.env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}`;
  const config = {
    port,
    role: selectedRole,
    surface: selectedRole === 'all-in-one' ? 'combined' : 'license-center',
    internalServiceToken: process.env.INTERNAL_SERVICE_TOKEN ?? '',
    databasePath: resolve(cwd, process.env.DATABASE_PATH ?? './var/data/appgog.sqlite'),
    activationPrivateKeyPath: resolve(cwd, process.env.ACTIVATION_SIGNING_PRIVATE_KEY_PATH ?? process.env.SIGNING_PRIVATE_KEY_PATH ?? './var/keys/ed25519-private.pem'),
    activationPublicKeyPath: resolve(cwd, process.env.ACTIVATION_SIGNING_PUBLIC_KEY_PATH ?? process.env.SIGNING_PUBLIC_KEY_PATH ?? './var/keys/ed25519-public.pem'),
    packagePrivateKeyPath: resolve(cwd, process.env.PACKAGE_SIGNING_PRIVATE_KEY_PATH ?? './var/keys/package-ed25519-private.pem'),
    packagePublicKeyPath: resolve(cwd, process.env.PACKAGE_SIGNING_PUBLIC_KEY_PATH ?? './var/keys/package-ed25519-public.pem'),
    notificationPrivateKeyPath: resolve(cwd, process.env.NOTIFICATION_SIGNING_PRIVATE_KEY_PATH ?? './var/keys/notification-ed25519-private.pem'),
    notificationPublicKeyPath: resolve(cwd, process.env.NOTIFICATION_SIGNING_PUBLIC_KEY_PATH ?? './var/keys/notification-ed25519-public.pem'),
    pepper: process.env.KEY_HASH_PEPPER ?? 'development-only-pepper-change-me-now',
    adminToken: process.env.ADMIN_TOKEN ?? 'development-admin-token-change-me',
    adminUsername: process.env.ADMIN_USERNAME ?? 'admin',
    adminPassword: process.env.ADMIN_PASSWORD ?? 'appgog-development-admin',
    workerToken: process.env.WORKER_TOKEN ?? 'development-worker-token-change-me',
    sessionSecret: process.env.SESSION_SECRET ?? 'development-session-secret-change-me-now',
    deliveryEncryptionKey: process.env.DELIVERY_ENCRYPTION_KEY ?? 'development-delivery-key-change-me-now',
    licenseEncryptionKey: process.env.LICENSE_ENCRYPTION_KEY ?? process.env.DELIVERY_ENCRYPTION_KEY ?? 'development-license-key-change-me-now',
    updateControlPath: resolve(cwd, process.env.UPDATE_CONTROL_PATH ?? './var/update-control'),
    publicBaseUrl,
    buildCenterPublicUrl: process.env.BUILD_CENTER_PUBLIC_URL ?? (selectedRole === 'all-in-one'
      ? new URL('/build', publicBaseUrl).href : `http://127.0.0.1:${buildPort}/build`),
    artifactRoot: resolve(cwd, process.env.ARTIFACT_ROOT ?? './var/artifacts'),
    uploadRoot: resolve(cwd, process.env.UPLOAD_ROOT ?? './var/uploads'),
    activationTokenTtlSeconds: integer('ACTIVATION_TOKEN_TTL_SECONDS', 604800),
    offlineGraceSeconds: integer('OFFLINE_GRACE_SECONDS', 2592000),
    buildTicketTtlSeconds: integer('BUILD_TICKET_TTL_SECONDS', 900),
    downloadTicketTtlSeconds: integer('DOWNLOAD_TICKET_TTL_SECONDS', 300),
    webSessionTtlSeconds: integer('WEB_SESSION_TTL_SECONDS', 28800),
    maxSourceUploadBytes: integer('MAX_SOURCE_UPLOAD_BYTES', 134217728),
    licenseServiceEnabled: boolean('LICENSE_SERVICE_ENABLED', true),
    customerLoginEnabled: boolean('CUSTOMER_LOGIN_ENABLED', true),
    buildCenterEnabled: boolean('BUILD_CENTER_ENABLED', true),
    newBuildsEnabled: boolean('NEW_BUILDS_ENABLED', true),
    workerEnabled: boolean('WORKER_ENABLED', true),
    embeddedWorker: (process.env.EMBEDDED_WORKER ?? (selectedRole === 'all-in-one' ? 'true' : 'false')).toLowerCase() === 'true',
    ...overrides,
  };
  config.role = overrides.role ?? selectedRole;
  config.surface = config.role === 'all-in-one' ? 'combined' : 'license-center';
  config.privateKeyPath = config.activationPrivateKeyPath;
  config.publicKeyPath = config.activationPublicKeyPath;
  if (process.env.NODE_ENV === 'production') {
    const secrets = ['KEY_HASH_PEPPER', 'ADMIN_TOKEN', 'WORKER_TOKEN', 'SESSION_SECRET', 'DELIVERY_ENCRYPTION_KEY', 'LICENSE_ENCRYPTION_KEY'];
    for (const name of secrets) {
      const value = process.env[name];
      if (!value || value.length < 32 || /^(replace-with|development-)/.test(value)) {
        throw new Error(`生产环境必须设置至少 32 字符的独立随机 ${name}`);
      }
    }
    if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 6) {
      throw new Error('生产环境必须设置 ADMIN_USERNAME 和至少 6 字符的 ADMIN_PASSWORD');
    }
    if (new URL(config.publicBaseUrl).protocol !== 'https:') {
      throw new Error('生产环境 PUBLIC_BASE_URL 必须使用 HTTPS');
    }
    if (new URL(config.buildCenterPublicUrl).protocol !== 'https:') {
      throw new Error('生产环境 BUILD_CENTER_PUBLIC_URL 必须使用 HTTPS');
    }
    if (config.role === 'license-center' && (!config.internalServiceToken || config.internalServiceToken.length < 32)) {
      throw new Error('授权中心生产模式必须设置至少 32 字符的 INTERNAL_SERVICE_TOKEN');
    }
  }
  if (!['all-in-one', 'license-center'].includes(config.role)) throw new Error('授权服务入口只允许 all-in-one 或 license-center 角色');
  return config;
}

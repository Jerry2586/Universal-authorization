import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { z } from 'zod';

const optionalSecret = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().min(32).optional(),
);
const optionalValue = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().optional(),
);

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  CHALLENGE_TTL_SECONDS: z.coerce.number().int().min(30).max(600).default(120),
  DATABASE_URL: z.string().url().default('postgresql://license:license@127.0.0.1:5432/license_server'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  INFRASTRUCTURE_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(5_000),
  REDIS_URL: z.string().url().default('redis://127.0.0.1:6379'),
  REDIS_KEY_PREFIX: z.string().min(1).max(64).default('license-server:'),
  MANAGEMENT_GATEWAY_TOKEN: optionalSecret,
  ADMIN_SESSION_TTL_SECONDS: z.coerce.number().int().min(900).max(604_800).default(28_800),
  ADMIN_COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
  ADMIN_WEB_ROOT: z.string().min(1).default('public/admin'),
  LICENSE_KEY_PEPPER: optionalSecret,
  LICENSE_SIGNING_PRIVATE_KEY_PEM_BASE64: optionalValue,
  LICENSE_SIGNING_KEY_ID: z.string().min(1).max(96).default('license-signing-v1'),
  LICENSE_TOKEN_ISSUER: z.string().min(1).max(128).default('universal-license-server'),
  LICENSE_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
  DEVICE_CERTIFICATE_TTL_SECONDS: z.coerce.number().int().min(300).max(31_536_000).default(2_592_000),
  ACTIVATION_REQUEST_MAX_SKEW_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
  ACTIVATION_IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().min(300).max(604_800).default(86_400),
  LICENSE_REQUEST_MAX_SKEW_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
  REQUEST_REPLAY_TTL_SECONDS: z.coerce.number().int().min(30).max(3_600).default(300),
  LICENSE_REFRESH_IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().min(300).max(604_800).default(86_400),
  SESSION_ACTION_IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().min(300).max(604_800).default(86_400),
  SESSION_ONLINE_TTL_SECONDS: z.coerce.number().int().min(30).max(7_200).default(180),
  HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().int().min(15).max(3_600).default(60),
  REFRESH_AFTER_SECONDS: z.coerce.number().int().min(30).max(86_400).default(600),
});

export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  challengeTtlSeconds: number;
  databaseUrl: string;
  databasePoolMax: number;
  databaseIdleTimeoutMs: number;
  infrastructureConnectTimeoutMs: number;
  redisUrl: string;
  redisKeyPrefix: string;
  managementGatewayToken?: string;
  adminSessionTtlSeconds: number;
  adminCookieSecure: boolean;
  adminWebRoot: string;
  licenseKeyPepper?: string;
  licenseSigningPrivateKeyPemBase64?: string;
  licenseSigningKeyId: string;
  licenseTokenIssuer: string;
  licenseTokenTtlSeconds: number;
  deviceCertificateTtlSeconds: number;
  activationRequestMaxSkewSeconds: number;
  activationIdempotencyTtlSeconds: number;
  licenseRequestMaxSkewSeconds: number;
  requestReplayTtlSeconds: number;
  licenseRefreshIdempotencyTtlSeconds: number;
  sessionActionIdempotencyTtlSeconds: number;
  sessionOnlineTtlSeconds: number;
  heartbeatIntervalSeconds: number;
  refreshAfterSeconds: number;
};

export function loadLocalEnvFile(path = resolve(process.cwd(), '.env')): void {
  if (existsSync(path)) loadEnvFile(path);
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);
  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    challengeTtlSeconds: parsed.CHALLENGE_TTL_SECONDS,
    databaseUrl: parsed.DATABASE_URL,
    databasePoolMax: parsed.DATABASE_POOL_MAX,
    databaseIdleTimeoutMs: parsed.DATABASE_IDLE_TIMEOUT_MS,
    infrastructureConnectTimeoutMs: parsed.INFRASTRUCTURE_CONNECT_TIMEOUT_MS,
    redisUrl: parsed.REDIS_URL,
    redisKeyPrefix: parsed.REDIS_KEY_PREFIX,
    ...(parsed.MANAGEMENT_GATEWAY_TOKEN === undefined ? {} : { managementGatewayToken: parsed.MANAGEMENT_GATEWAY_TOKEN }),
    adminSessionTtlSeconds: parsed.ADMIN_SESSION_TTL_SECONDS,
    adminCookieSecure: parsed.ADMIN_COOKIE_SECURE === 'true',
    adminWebRoot: parsed.ADMIN_WEB_ROOT,
    ...(parsed.LICENSE_KEY_PEPPER === undefined ? {} : { licenseKeyPepper: parsed.LICENSE_KEY_PEPPER }),
    ...(parsed.LICENSE_SIGNING_PRIVATE_KEY_PEM_BASE64 === undefined ? {} : { licenseSigningPrivateKeyPemBase64: parsed.LICENSE_SIGNING_PRIVATE_KEY_PEM_BASE64 }),
    licenseSigningKeyId: parsed.LICENSE_SIGNING_KEY_ID,
    licenseTokenIssuer: parsed.LICENSE_TOKEN_ISSUER,
    licenseTokenTtlSeconds: parsed.LICENSE_TOKEN_TTL_SECONDS,
    deviceCertificateTtlSeconds: parsed.DEVICE_CERTIFICATE_TTL_SECONDS,
    activationRequestMaxSkewSeconds: parsed.ACTIVATION_REQUEST_MAX_SKEW_SECONDS,
    activationIdempotencyTtlSeconds: parsed.ACTIVATION_IDEMPOTENCY_TTL_SECONDS,
    licenseRequestMaxSkewSeconds: parsed.LICENSE_REQUEST_MAX_SKEW_SECONDS,
    requestReplayTtlSeconds: parsed.REQUEST_REPLAY_TTL_SECONDS,
    licenseRefreshIdempotencyTtlSeconds: parsed.LICENSE_REFRESH_IDEMPOTENCY_TTL_SECONDS,
    sessionActionIdempotencyTtlSeconds: parsed.SESSION_ACTION_IDEMPOTENCY_TTL_SECONDS,
    sessionOnlineTtlSeconds: parsed.SESSION_ONLINE_TTL_SECONDS,
    heartbeatIntervalSeconds: parsed.HEARTBEAT_INTERVAL_SECONDS,
    refreshAfterSeconds: parsed.REFRESH_AFTER_SECONDS,
  };
}

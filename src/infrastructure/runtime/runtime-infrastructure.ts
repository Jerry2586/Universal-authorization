import type { AppConfig } from '../../config/env.js';
import { RedisCache } from '../cache/redis-cache.js';
import { PostgresDatabase } from '../database/postgres-database.js';
import { RedisChallengeStore } from '../../modules/challenges/infrastructure/redis-challenge.store.js';
import type { ReadinessReport } from '../../shared/health/readiness.js';
import { PostgresAuditLog } from '../../modules/audit/infrastructure/postgres-audit-log.js';
import { PostgresProductRepository } from '../../modules/products/infrastructure/postgres-product.repository.js';
import { PostgresLicenseRepository } from '../../modules/licenses/infrastructure/postgres-license.repository.js';
import { PostgresAdminPrincipalResolver } from '../../modules/identity/infrastructure/postgres-admin-principal.resolver.js';
import { PostgresActivationRepository } from '../../modules/activations/infrastructure/postgres-activation.repository.js';
import { PostgresActivationIdempotencyStore } from '../../modules/activations/infrastructure/postgres-activation-idempotency.store.js';
import { PostgresLicenseRuntimeRepository } from '../../modules/verification/infrastructure/postgres-license-runtime.repository.js';
import { PostgresLicenseRefreshIdempotencyStore } from '../../modules/refresh/infrastructure/postgres-license-refresh-idempotency.store.js';
import { RedisRequestReplayStore } from '../../modules/security/infrastructure/redis-request-replay.store.js';
import { RedisOnlineSessionStore } from '../../modules/sessions/infrastructure/redis-online-session.store.js';
import { PostgresSessionActionIdempotencyStore } from '../../modules/session-actions/infrastructure/postgres-session-action-idempotency.store.js';
import { PostgresAdminDeviceRepository } from '../../modules/admin-devices/infrastructure/postgres-admin-device.repository.js';
import { PostgresAdminAuditQueryRepository } from '../../modules/admin-audit/infrastructure/postgres-admin-audit-query.repository.js';

export class RuntimeInfrastructure {
  public readonly database: PostgresDatabase;
  public readonly cache: RedisCache;
  public readonly challengeStore: RedisChallengeStore;
  public readonly auditLog: PostgresAuditLog;
  public readonly productRepository: PostgresProductRepository;
  public readonly licenseRepository: PostgresLicenseRepository;
  public readonly adminPrincipalResolver: PostgresAdminPrincipalResolver;
  public readonly activationRepository: PostgresActivationRepository;
  public readonly activationIdempotencyStore: PostgresActivationIdempotencyStore;
  public readonly licenseRuntimeRepository: PostgresLicenseRuntimeRepository;
  public readonly licenseRefreshIdempotencyStore: PostgresLicenseRefreshIdempotencyStore;
  public readonly requestReplayStore: RedisRequestReplayStore;
  public readonly onlineSessionStore: RedisOnlineSessionStore;
  public readonly sessionActionIdempotencyStore: PostgresSessionActionIdempotencyStore;
  public readonly adminDeviceRepository: PostgresAdminDeviceRepository;
  public readonly adminAuditQueryRepository: PostgresAdminAuditQueryRepository;

  public constructor(config: AppConfig, onError: (component: string, error: Error) => void = () => undefined) {
    this.database = new PostgresDatabase({
      connectionString: config.databaseUrl,
      maxConnections: config.databasePoolMax,
      idleTimeoutMs: config.databaseIdleTimeoutMs,
      connectionTimeoutMs: config.infrastructureConnectTimeoutMs,
      applicationName: 'universal-license-server',
      onError: (error) => onError('postgresql', error),
    });
    this.cache = new RedisCache({
      url: config.redisUrl,
      connectTimeoutMs: config.infrastructureConnectTimeoutMs,
      onError: (error) => onError('redis', error),
    });
    this.challengeStore = new RedisChallengeStore(this.cache, config.redisKeyPrefix);
    this.auditLog = new PostgresAuditLog(this.database);
    this.productRepository = new PostgresProductRepository(this.database);
    this.licenseRepository = new PostgresLicenseRepository(this.database);
    this.adminPrincipalResolver = new PostgresAdminPrincipalResolver(this.database, config.managementGatewayToken);
    this.activationRepository = new PostgresActivationRepository(this.database);
    this.activationIdempotencyStore = new PostgresActivationIdempotencyStore(this.database);
    this.licenseRuntimeRepository = new PostgresLicenseRuntimeRepository(this.database);
    this.licenseRefreshIdempotencyStore = new PostgresLicenseRefreshIdempotencyStore(this.database);
    this.requestReplayStore = new RedisRequestReplayStore(this.cache, config.redisKeyPrefix);
    this.onlineSessionStore = new RedisOnlineSessionStore(this.cache, config.redisKeyPrefix);
    this.sessionActionIdempotencyStore = new PostgresSessionActionIdempotencyStore(this.database);
    this.adminDeviceRepository = new PostgresAdminDeviceRepository(this.database);
    this.adminAuditQueryRepository = new PostgresAdminAuditQueryRepository(this.database);
  }

  public async connect(): Promise<void> {
    await this.database.connect();
    try { await this.cache.connect(); } catch (error) { await this.database.close(); throw error; }
  }

  public async close(): Promise<void> {
    await Promise.allSettled([this.cache.close(), this.database.close()]);
  }

  public async readiness(): Promise<ReadinessReport> {
    const [database, redis] = await Promise.all([
      this.checkComponent(() => this.database.ping()),
      this.checkComponent(() => this.cache.ping()),
    ]);
    return { ready: database.status === 'up' && redis.status === 'up', components: { postgresql: database, redis } };
  }

  private async checkComponent(check: () => Promise<number>): Promise<{ status: 'up' | 'down'; latencyMs: number; message?: string }> {
    const startedAt = performance.now();
    try { return { status: 'up', latencyMs: await check() }; }
    catch (error) {
      return {
        status: 'down',
        latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
        message: error instanceof Error ? error.message : 'Unknown infrastructure error',
      };
    }
  }
}





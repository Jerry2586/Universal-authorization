import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { RedisCache } from '../../infrastructure/cache/redis-cache.js';
import { AppError } from '../../shared/errors/app-error.js';

export interface AdminSession {
  userId: string;
  sessionVersion: number;
  csrfToken: string;
  createdAt: string;
  expiresAt: string;
}

export interface CreatedAdminSession extends AdminSession {
  sessionToken: string;
}

export class AdminSessionStore {
  public constructor(
    private readonly cache: RedisCache,
    private readonly keyPrefix: string,
    private readonly ttlSeconds: number,
  ) {}

  public async create(userId: string, sessionVersion: number): Promise<CreatedAdminSession> {
    const sessionToken = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(24).toString('base64url');
    const now = new Date();
    const session: AdminSession = {
      userId,
      sessionVersion,
      csrfToken,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlSeconds * 1000).toISOString(),
    };
    await this.cache.set(this.sessionKey(sessionToken), JSON.stringify(session), this.ttlSeconds);
    return { ...session, sessionToken };
  }

  public async read(sessionToken: string): Promise<AdminSession | null> {
    if (sessionToken.length < 32 || sessionToken.length > 256) return null;
    const value = await this.cache.get(this.sessionKey(sessionToken));
    if (value === null) return null;
    try {
      const session = JSON.parse(value) as Partial<AdminSession>;
      if (typeof session.userId !== 'string' || typeof session.sessionVersion !== 'number' || typeof session.csrfToken !== 'string' || typeof session.createdAt !== 'string' || typeof session.expiresAt !== 'string') return null;
      if (Date.parse(session.expiresAt) <= Date.now()) return null;
      return session as AdminSession;
    } catch {
      return null;
    }
  }

  public async require(sessionToken: string, suppliedCsrf?: string): Promise<AdminSession> {
    const session = await this.read(sessionToken);
    if (session === null) {
      throw new AppError({ code: 'ADMIN_SESSION_INVALID', message: '登录已失效，请重新登录', statusCode: 401 });
    }
    if (suppliedCsrf !== undefined && !safeEqual(suppliedCsrf, session.csrfToken)) {
      throw new AppError({ code: 'ADMIN_CSRF_INVALID', message: '安全校验失败，请刷新页面后重试', statusCode: 403 });
    }
    return session;
  }

  public async destroy(sessionToken: string): Promise<void> {
    await this.cache.delete(this.sessionKey(sessionToken));
  }

  public async registerFailure(scope: 'ip' | 'account', identity: string, windowSeconds: number): Promise<number> {
    return this.cache.incrementWithTtl(`${this.keyPrefix}admin-login:${scope}:${hash(identity)}`, windowSeconds);
  }

  public async failureCount(scope: 'ip' | 'account', identity: string): Promise<number> {
    const value = await this.cache.get(`${this.keyPrefix}admin-login:${scope}:${hash(identity)}`);
    return value === null ? 0 : Number(value);
  }

  public async clearFailures(scope: 'ip' | 'account', identity: string): Promise<void> {
    await this.cache.delete(`${this.keyPrefix}admin-login:${scope}:${hash(identity)}`);
  }

  private sessionKey(token: string): string {
    return `${this.keyPrefix}admin-session:${hash(token)}`;
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

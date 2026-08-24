import { describe, expect, it } from 'vitest';
import { hashAdminPassword, verifyAdminPassword } from '../src/modules/admin-auth/admin-password.js';
import { clearSessionCookie, parseCookie, sessionCookie } from '../src/modules/admin-auth/admin-cookie.js';

describe('管理员登录安全基础', () => {
  it('使用 scrypt 哈希并验证密码', async () => {
    const encoded = await hashAdminPassword('Strong-Password-123!');
    expect(encoded).toMatch(/^scrypt\$/);
    expect(encoded).not.toContain('Strong-Password-123!');
    await expect(verifyAdminPassword('Strong-Password-123!', encoded)).resolves.toBe(true);
    await expect(verifyAdminPassword('wrong-password', encoded)).resolves.toBe(false);
  });

  it('生成 HttpOnly SameSite Cookie', () => {
    const value = sessionCookie('secret-token', { secure: true, maxAge: 3600 });
    expect(value).toContain('HttpOnly');
    expect(value).toContain('SameSite=Lax');
    expect(value).toContain('Secure');
    expect(parseCookie('a=1; ua_admin_session=secret-token', 'ua_admin_session')).toBe('secret-token');
    expect(clearSessionCookie(true)).toContain('Max-Age=0');
  });
});

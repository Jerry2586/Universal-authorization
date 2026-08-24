import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('管理后台成熟化第一阶段迁移', () => {
  it('增加会话版本、密码变更时间和工作区设置权限', async () => {
    const sql = await readFile(resolve(process.cwd(), 'database', 'migrations', '0008_admin_console_foundation.sql'), 'utf8');
    expect(sql).toMatch(/session_version INTEGER NOT NULL DEFAULT 1/i);
    expect(sql).toMatch(/password_changed_at TIMESTAMPTZ/i);
    expect(sql).toMatch(/tenant\.settings\.manage/i);
    expect(sql).toMatch(/role_permissions/i);
    expect(sql).toMatch(/DELETE FROM role_permissions[\s\S]*platform\.tenants\.manage/i);
    expect(sql).toMatch(/tenant-owner|owner/i);
  });

  it('管理员引导不会把平台专属权限授予租户 owner', async () => {
    const source = await readFile(resolve(process.cwd(), 'scripts', 'bootstrap-admin.ts'), 'utf8');
    expect(source).toContain("WHERE code NOT IN ('platform.tenants.manage', 'settings.manage', 'signing-keys.manage')");
  });
});

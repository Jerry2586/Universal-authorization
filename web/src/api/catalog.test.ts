import { describe, expect, it } from 'vitest';
import { allEndpoints, authEndpoints, clientEndpoints, managementEndpoints } from './catalog';

describe('Web 管理后台接口目录', () => {
  it('覆盖当前全部 52 个服务端路由且没有重复项', () => {
    expect(clientEndpoints).toHaveLength(7);
    expect(managementEndpoints).toHaveLength(39);
    expect(authEndpoints).toHaveLength(6);
    expect(allEndpoints).toHaveLength(52);
    expect(new Set(allEndpoints.map((item) => `${item.method} ${item.path}`)).size).toBe(allEndpoints.length);
  });

  it('每个管理接口都有真实 UI 映射和权限说明', () => {
    for (const endpoint of managementEndpoints) {
      expect(endpoint.ui).not.toBe('');
      expect(endpoint.permission).not.toBe('');
      expect(endpoint.path.startsWith('/admin/v1/')).toBe(true);
    }
  });
});

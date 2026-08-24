export interface ApiCatalogItem {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  path: string;
  name: string;
  permission?: string;
  ui: string;
}

export const clientEndpoints: readonly ApiCatalogItem[] = [
  { method: 'POST', path: '/api/v1/challenges', name: '申请设备签名挑战', ui: '真实客户端 SDK' },
  { method: 'POST', path: '/api/v1/licenses/activate', name: '首次激活授权', ui: '真实客户端 SDK' },
  { method: 'POST', path: '/api/v1/licenses/verify', name: '在线验证授权', ui: '真实客户端 SDK' },
  { method: 'POST', path: '/api/v1/licenses/refresh', name: '刷新授权令牌', ui: '真实客户端 SDK' },
  { method: 'POST', path: '/api/v1/sessions/heartbeat', name: '上报会话心跳', ui: '真实客户端 SDK' },
  { method: 'POST', path: '/api/v1/sessions/release', name: '释放在线会话', ui: '真实客户端 SDK' },
  { method: 'POST', path: '/api/v1/devices/unbind', name: '设备自助解绑', ui: '真实客户端 SDK' },
];

export const managementEndpoints: readonly ApiCatalogItem[] = [
  { method: 'POST', path: '/admin/v1/products', name: '创建产品', permission: 'products.write', ui: '产品管理' },
  { method: 'GET', path: '/admin/v1/products', name: '产品分页列表', permission: 'products.read', ui: '产品管理/控制台/Key 管理' },
  { method: 'GET', path: '/admin/v1/products/:productId', name: '产品详情', permission: 'products.read', ui: '产品管理' },
  { method: 'PATCH', path: '/admin/v1/products/:productId', name: '修改产品', permission: 'products.write', ui: '产品管理' },
  { method: 'POST', path: '/admin/v1/products/:productId/versions', name: '创建版本', permission: 'products.write', ui: '产品管理' },
  { method: 'GET', path: '/admin/v1/products/:productId/versions', name: '版本列表', permission: 'products.read', ui: '产品管理' },
  { method: 'PATCH', path: '/admin/v1/products/:productId/versions/:versionId', name: '修改版本', permission: 'products.write', ui: '产品管理' },
  { method: 'POST', path: '/admin/v1/products/:productId/features', name: '创建功能定义', permission: 'products.write', ui: '产品管理' },
  { method: 'GET', path: '/admin/v1/products/:productId/features', name: '功能定义列表', permission: 'products.read', ui: '产品管理/Key 管理' },
  { method: 'PATCH', path: '/admin/v1/products/:productId/features/:featureId', name: '修改功能定义', permission: 'products.write', ui: '产品管理' },
  { method: 'POST', path: '/admin/v1/license-policies', name: '创建授权策略', permission: 'licenses.write', ui: '授权策略' },
  { method: 'GET', path: '/admin/v1/license-policies', name: '授权策略分页列表', permission: 'licenses.read', ui: '授权策略/控制台/Key 管理' },
  { method: 'PATCH', path: '/admin/v1/license-policies/:policyId', name: '修改授权策略', permission: 'licenses.write', ui: '授权策略' },
  { method: 'POST', path: '/admin/v1/license-keys', name: '生成单枚 Key', permission: 'licenses.write', ui: 'Key 管理' },
  { method: 'POST', path: '/admin/v1/license-keys/batch', name: '批量生成 Key', permission: 'licenses.write + licenses.export', ui: 'Key 管理' },
  { method: 'GET', path: '/admin/v1/license-keys', name: 'Key 分页列表', permission: 'licenses.read', ui: 'Key 管理/控制台' },
  { method: 'GET', path: '/admin/v1/license-keys/:licenseId', name: 'Key 详情', permission: 'licenses.read', ui: 'Key 管理' },
  { method: 'POST', path: '/admin/v1/license-keys/:licenseId/suspend', name: '暂停 Key', permission: 'licenses.write', ui: 'Key 管理' },
  { method: 'POST', path: '/admin/v1/license-keys/:licenseId/resume', name: '恢复 Key', permission: 'licenses.write', ui: 'Key 管理' },
  { method: 'POST', path: '/admin/v1/license-keys/:licenseId/renew', name: '续期 Key', permission: 'licenses.write', ui: 'Key 管理' },
  { method: 'POST', path: '/admin/v1/license-keys/:licenseId/revoke', name: '永久吊销 Key', permission: 'licenses.write', ui: 'Key 管理' },
  { method: 'GET', path: '/admin/v1/license-keys/:licenseId/devices', name: 'Key 绑定设备列表', permission: 'devices.read', ui: 'Key 管理' },
  { method: 'POST', path: '/admin/v1/devices/:deviceId/unbind', name: '管理员强制解绑', permission: 'devices.unbind', ui: 'Key 管理' },
  { method: 'POST', path: '/admin/v1/devices/:deviceId/block', name: '封禁设备', permission: 'devices.block', ui: 'Key 管理' },
  { method: 'POST', path: '/admin/v1/devices/:deviceId/unblock', name: '解封设备', permission: 'devices.block', ui: 'Key 管理' },
  { method: 'GET', path: '/admin/v1/admin-users', name: '管理员分页列表', permission: 'admin.users.manage', ui: '管理员与角色' },
  { method: 'POST', path: '/admin/v1/admin-users', name: '创建管理员', permission: 'admin.users.manage', ui: '管理员与角色' },
  { method: 'PATCH', path: '/admin/v1/admin-users/:adminId', name: '修改管理员', permission: 'admin.users.manage', ui: '管理员与角色' },
  { method: 'POST', path: '/admin/v1/admin-users/:adminId/reset-password', name: '重置管理员密码', permission: 'admin.users.manage', ui: '管理员与角色' },
  { method: 'PATCH', path: '/admin/v1/profile', name: '修改个人资料', permission: '登录管理员', ui: '个人中心' },
  { method: 'POST', path: '/admin/v1/profile/change-password', name: '修改自己的密码', permission: '登录管理员', ui: '个人中心' },
  { method: 'GET', path: '/admin/v1/admin-roles', name: '角色列表', permission: 'admin.users.manage', ui: '管理员与角色' },
  { method: 'GET', path: '/admin/v1/admin-permissions', name: '权限目录', permission: 'admin.roles.manage', ui: '管理员与角色' },
  { method: 'POST', path: '/admin/v1/admin-roles', name: '创建角色', permission: 'admin.roles.manage', ui: '管理员与角色' },
  { method: 'PATCH', path: '/admin/v1/admin-roles/:roleId', name: '修改角色权限', permission: 'admin.roles.manage', ui: '管理员与角色' },
  { method: 'GET', path: '/admin/v1/settings/tenant', name: '读取工作区设置', permission: 'tenant.settings.manage', ui: '系统设置' },
  { method: 'PUT', path: '/admin/v1/settings/tenant', name: '保存工作区设置', permission: 'tenant.settings.manage', ui: '系统设置' },
  { method: 'GET', path: '/admin/v1/audit-logs', name: '管理员审计完整查询', permission: 'audit.read', ui: '审计与事件' },
  { method: 'GET', path: '/admin/v1/license-events', name: '授权事件完整查询', permission: 'audit.read', ui: '审计与事件' },
];

export const authEndpoints: readonly ApiCatalogItem[] = [
  { method: 'GET', path: '/health', name: '进程健康检查', ui: '全局状态/API 中心' },
  { method: 'GET', path: '/ready', name: '数据库与 Redis 就绪检查', ui: '全局状态/API 中心' },
  { method: 'POST', path: '/admin/auth/login', name: '管理员登录', ui: '登录页' },
  { method: 'GET', path: '/admin/auth/me', name: '读取当前管理员会话', ui: '会话初始化' },
  { method: 'GET', path: '/admin/auth/csrf', name: '刷新 CSRF 安全令牌', ui: 'API 中心' },
  { method: 'POST', path: '/admin/auth/logout', name: '管理员退出登录', ui: '用户菜单' },
];

export const allEndpoints = [...clientEndpoints, ...managementEndpoints, ...authEndpoints] as const;

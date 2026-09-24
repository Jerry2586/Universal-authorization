export const ROLE_PERMISSIONS = Object.freeze({
  owner: ['*'],
  super_admin: ['*'],
  license_ops: ['dashboard.view', 'license.view', 'license.issue', 'license.manage', 'build.view', 'activation.view', 'ticket.view', 'ticket.manage', 'audit.view'],
  release_manager: ['dashboard.view', 'version.view', 'version.publish', 'version.manage', 'build.view', 'ticket.view', 'audit.view'],
  support: ['dashboard.view', 'license.view', 'build.view', 'activation.view', 'ticket.view', 'ticket.manage'],
  auditor: ['dashboard.view', 'license.view', 'version.view', 'build.view', 'activation.view', 'ticket.view', 'audit.view'],
});

export function adminPermissions(admin) {
  const base = ROLE_PERMISSIONS[admin?.role] ?? [];
  let extra = [];
  try { extra = JSON.parse(admin?.permissions_json ?? '[]'); } catch { extra = []; }
  return [...new Set([...base, ...(Array.isArray(extra) ? extra : [])])];
}

export function adminCan(admin, permission) {
  const permissions = adminPermissions(admin);
  return permissions.includes('*') || permissions.includes(permission);
}

export const ADMIN_ROLES = Object.freeze(Object.keys(ROLE_PERMISSIONS));

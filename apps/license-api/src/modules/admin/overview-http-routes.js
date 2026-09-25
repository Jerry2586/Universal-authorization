export async function handleAdminOverviewHttp({ method, url, response, portal, auth, respondJson }) {
  if (method !== 'GET' || url.pathname !== '/web/admin/overview') return false;
  const admin = auth.requireAdmin(false, 'dashboard.view');
  const overview = portal.adminOverview();
  if (!admin.permissions.includes('*')) {
    if (!admin.permissions.includes('license.view')) {
      overview.licenses = [];
      overview.license_plans = [];
      overview.domain_migrations = [];
    }
    if (!admin.permissions.includes('version.view')) overview.versions = [];
    if (!admin.permissions.includes('build.view')) overview.builds = [];
    if (!admin.permissions.includes('activation.view')) overview.activations = [];
    if (!admin.permissions.includes('audit.view')) overview.audit = [];
    if (!admin.permissions.includes('ticket.view')) overview.tickets = [];
    if (!admin.permissions.includes('admin.manage')) overview.admins = [];
    if (!admin.permissions.includes('system.manage')) overview.cms = null;
  }
  respondJson(response, 200, overview);
  return true;
}

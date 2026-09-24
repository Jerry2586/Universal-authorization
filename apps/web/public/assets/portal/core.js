export const $ = (id) => document.getElementById(id);

export function createPortalState(actor) {
  if (!['admin', 'customer'].includes(actor)) throw new Error(`不支持的门户身份：${actor}`);
  return {
    actor,
    csrf: null,
    data: null,
    loading: false,
    notificationTimer: null,
    permissions: [],
    session: null,
    selectedCustomerTicketId: null,
    selectedAdminTicketId: null,
    sourceFile: null,
  };
}

export function createPermissionCheck(state) {
  return (permission) => state.actor === 'admin'
    && (state.permissions.includes('*') || state.permissions.includes(permission));
}

export const mode = document.body.dataset.portal;
export const $ = (id) => document.getElementById(id);

export const state = {
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

export function can(permission) {
  return mode === 'admin' && (state.permissions.includes('*') || state.permissions.includes(permission));
}

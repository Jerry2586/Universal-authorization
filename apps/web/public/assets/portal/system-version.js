// Runtime version comes from the server; release candidates/latest are separate values.
export function applySystemVersion(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) return;
  for (const id of ['login-system-version', 'admin-system-version', 'customer-system-version', 'update-current-version']) {
    const node = document.getElementById(id);
    if (node) node.textContent = 'v' + version;
  }
}

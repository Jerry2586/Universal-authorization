// Runtime version comes from the server; release candidates/latest are separate values.
export function applySystemVersion(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) return;
  for (const id of ['login-system-version', 'admin-system-version', 'customer-system-version', 'update-current-version']) {
    const node = document.getElementById(id);
    if (node) node.textContent = 'v' + version;
  }
}

// Never apply a new workflow to an old HTML form still open across an upgrade.
export function ensurePortalDocument(version) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version ?? '')) return true;
  const loaded = document.querySelector('meta[name="appgog-document-version"]')?.content;
  if (loaded === version) return true;
  let notice = document.getElementById('portal-version-notice');
  if (!notice) {
    notice = document.createElement('div'); notice.id = 'portal-version-notice';
    notice.className = 'portal-version-notice'; notice.setAttribute('role','alert');
    document.body.prepend(notice);
  }
  notice.replaceChildren(document.createTextNode('系统已更新，当前页面版本已过期，请刷新后继续操作。'));
  const target = new URL(location.href); target.searchParams.set('appgog_version',version);
  const link = document.createElement('a'); link.textContent = '加载新版页面'; link.href = target.href; notice.append(link);
  const form = document.getElementById('version-form');
  if (form) form.querySelector('[type="submit"]').disabled = true;
  const unchanged = new URL(location.href).searchParams.get('appgog_version') === version;
  if (!unchanged && !form?.hasAttribute('aria-busy')) location.replace(target.href);
  return false;
}

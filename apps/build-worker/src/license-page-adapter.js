import { createHash } from 'node:crypto';
import { invariant } from '../../../packages/core/src/errors.js';

// A bounded adapter for the APPGOG hash router; other products are untouched.
// Keep authentication and all business routes owned by the original router.
export function integrateLicensePage(files, root) {
  const path = `${root}assets/js/panel.js`;
  const original = files.get(path)?.toString('utf8');
  const boot = files.get(`${root}assets/js/theme-boot.js`)?.toString('utf8');
  if (!original || !boot?.includes('appgog_boot_background')) return;
  const routeAnchor = 'const routes = {';
  const shellAnchor = 'function initShell() {';
  const navigationAnchor = 'currentRoute = hash;';
  invariant(original.includes(routeAnchor) && original.includes(shellAnchor) && original.includes(navigationAnchor), 'SOURCE_PANEL_ADAPTER_UNSUPPORTED', 'APPGOG 用户面板结构已变化，无法安全接入授权与更新页面', 409);
  invariant(!original.includes('renderAppgogLicensePage'), 'SOURCE_ALREADY_PROTECTED', '用户面板已接入授权运行时', 409);
  const source = original.replace(routeAnchor, `
  let disposeLicensePage = null;
  function renderAppgogLicensePage(view) {
    if (disposeLicensePage) disposeLicensePage();
    let page = null;
    const render = () => {
      if (currentRoute !== 'license' || !view.isConnected) return;
      page?.dispose?.();
      if (window.APPGOGLicense?.mount) page = window.APPGOGLicense.mount(view);
      else view.textContent = '正在读取授权状态…';
    };
    const cleanup = () => {
      page?.dispose?.();
      window.removeEventListener('appgog-license-ready', render);
      window.removeEventListener('hashchange', cleanup);
      window.removeEventListener('appgog-session-expired', cleanup);
    };
    disposeLicensePage = cleanup;
    window.addEventListener('appgog-license-ready', render);
    window.addEventListener('hashchange', cleanup, { once: true });
    window.addEventListener('appgog-session-expired', cleanup, { once: true });
    render();
  }
  ${routeAnchor}
    license: { title: '授权与更新', sub: '账户中心', render: renderAppgogLicensePage },`)
    .replace(shellAnchor, `${shellAnchor}
      if (!document.querySelector('[data-route="license"]')) {
        const settings = document.querySelector('#sideNav [data-route="settings"]');
        const license = document.createElement('a');
        license.href = '#/license'; license.className = 'nav-item'; license.dataset.route = 'license';
        license.innerHTML = icon('shield','nav-ic') + '<span class="nav-label">授权与更新</span>';
        settings?.after(license);
      }`).replace(navigationAnchor, navigationAnchor + `
    document.body.classList.toggle('license-route', hash === 'license');`);
  files.set(path, Buffer.from(source));
}

// Version both static entry references and the dynamic loader in one build.
// The build identity changes even when the product version is built again.
export function versionThemeAssets(files, root, buildId) {
  if (!files.get(root + 'assets/js/theme-boot.js')?.toString().includes('appgog_boot_background')) return;
  invariant(typeof buildId === 'string' && buildId.length > 0, 'BUILD_ID_REQUIRED', '缺少资源构建标识', 500);
  const revision = createHash('sha256').update(buildId).digest('hex').slice(0, 20);
  const loaderPath = root + 'assets/js/root-entry.js';
  if (files.has(loaderPath)) {
    const loader = files.get(loaderPath).toString('utf8');
    invariant(/const version = ['"][\w.-]+['"];/.test(loader), 'SOURCE_ASSET_LOADER_UNSUPPORTED', '主题资源加载器结构已变化，无法安全刷新资源缓存', 409);
    files.set(loaderPath, Buffer.from(loader.replace(/const version = ['"][\w.-]+['"];/, "const version = '" + revision + "';")));
  }
  for (const [path, buffer] of files) {
    if (!path.startsWith(root) || !/\.(?:html|js|css|blade\.php)$/i.test(path)) continue;
    const source = buffer.toString('utf8');
    const next = source.replace(/(["'`])([^"'`\r\n]*\.(?:js|css)\?v=)([\w.-]+)(?=["'`&#])/g, (all, quote, url) => {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url) || !/(?:^|\/)assets\//.test(url)) return all;
      return quote + url + revision;
    });
    if (next !== source) files.set(path, Buffer.from(next));
  }
}

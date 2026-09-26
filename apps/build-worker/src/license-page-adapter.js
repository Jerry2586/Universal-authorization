import { createHash } from 'node:crypto';
import { invariant } from '../../../packages/core/src/errors.js';

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

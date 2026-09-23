import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { BuildEngine } from '../../../packages/ports/src/build-engine.js';
import { invariant } from '../../../packages/core/src/errors.js';
import { readZip, writeZip } from '../../../packages/core/src/zip.js';
import { createBuildInjection } from './manifest.js';
import { createBrowserLicenseRuntime } from './runtime.js';

const BLOCKED_EXTENSIONS = new Set(['.exe', '.dll', '.so', '.dylib', '.bat', '.cmd', '.ps1', '.sh', '.phar', '.jar']);

function extension(name) {
  const lower = name.toLowerCase();
  const index = lower.lastIndexOf('.');
  return index >= 0 ? lower.slice(index) : '';
}

function rootCandidates(files) {
  const candidates = [];
  for (const name of files.keys()) {
    const base = posix.basename(name).toLowerCase();
    if (base === 'index.html' || base === 'dashboard.blade.php') candidates.push(name);
  }
  return candidates;
}

function injectRuntime(html, runtimeSrc, marker) {
  invariant(!html.includes('data-appgog-license-runtime'), 'SOURCE_ALREADY_PROTECTED', '主题包已经包含 APPGOG 授权运行时', 409);
  const tag = `<script data-appgog-license-runtime="${marker}" src="${runtimeSrc}"></script>`;
  if (/<\/head\s*>/i.test(html)) return html.replace(/<\/head\s*>/i, `${tag}</head>`);
  if (/<body(?:\s[^>]*)?>/i.test(html)) return html.replace(/<body(?:\s[^>]*)?>/i, (match) => `${tag}${match}`);
  return `${tag}${html}`;
}

export class HardenedThemeBuildEngine extends BuildEngine {
  constructor({ artifactStore, publicKey, publicBaseUrl }) {
    super();
    this.artifactStore = artifactStore;
    this.publicKey = publicKey;
    this.publicBaseUrl = publicBaseUrl;
  }

  validateSource(buffer) {
    const files = readZip(buffer);
    invariant(files.size >= 2, 'SOURCE_EMPTY', '主题 ZIP 内容过少', 400);
    for (const name of files.keys()) {
      const ext = extension(name);
      invariant(!BLOCKED_EXTENSIONS.has(ext), 'SOURCE_EXECUTABLE_REJECTED', `主题 ZIP 含不允许的可执行文件：${name}`, 400);
      if (ext === '.php') invariant(name.toLowerCase().endsWith('.blade.php'), 'SOURCE_PHP_REJECTED', `只允许 Xboard Blade 模板，不允许普通 PHP：${name}`, 400);
    }
    const entries = rootCandidates(files);
    invariant(entries.length > 0, 'SOURCE_ENTRY_NOT_FOUND', '主题 ZIP 必须包含 index.html 或 dashboard.blade.php', 400);
    const hasConfig = [...files.keys()].some((name) => posix.basename(name).toLowerCase() === 'config.json');
    invariant(hasConfig, 'SOURCE_CONFIG_NOT_FOUND', '主题 ZIP 必须包含 Xboard 主题 config.json', 400);
    return { files, entries };
  }

  async build({ sourceRef, sourceBuffer: providedSourceBuffer, product, version, buildId, packageId, packageSecret, domain }) {
    const sourceBuffer = providedSourceBuffer ?? this.artifactStore.read(sourceRef);
    const { files, entries } = this.validateSource(sourceBuffer);
    const injection = createBuildInjection({
      product,
      version,
      buildId,
      packageId,
      packageSecret,
      licenseServer: this.publicBaseUrl,
      publicKey: this.publicKey,
    });
    const runtime = createBrowserLicenseRuntime({ injection, publicKeyPem: this.publicKey });
    const roots = entries.map((entry) => posix.dirname(entry)).sort((a, b) => a.length - b.length);
    const root = roots[0] === '.' ? '' : `${roots[0]}/`;
    const runtimePath = `${root}appgog-license/runtime.${packageId.slice(-12)}.js`;
    files.set(runtimePath, Buffer.from(runtime, 'utf8'));
    for (const entry of entries) {
      const html = files.get(entry).toString('utf8');
      const relative = posix.relative(posix.dirname(entry), runtimePath);
      const runtimeSrc = relative.startsWith('.') ? relative : `./${relative}`;
      files.set(entry, Buffer.from(injectRuntime(html, runtimeSrc, packageId), 'utf8'));
    }
    files.set(`${root}appgog-license/build.json`, Buffer.from(JSON.stringify({
      schema: 1,
      product,
      version,
      build_id: buildId,
      package_id: packageId,
      domain,
      license_server: this.publicBaseUrl,
      created_at: new Date().toISOString(),
    }, null, 2)));
    files.set(`${root}APPGOG-ACTIVATION.txt`, Buffer.from([
      'APPGOG 授权主题包',
      `版本: ${version}`,
      `授权域名: ${domain}`,
      `Build ID: ${buildId}`,
      `Package ID: ${packageId}`,
      '',
      '安装后打开主题后台，输入打包中心显示的一次性安装 Key 与固定授权 Key 完成激活。',
    ].join('\r\n'), 'utf8'));
    const output = writeZip(files);
    return {
      buffer: output,
      sha256: createHash('sha256').update(output).digest('hex'),
      fileCount: files.size,
    };
  }
}

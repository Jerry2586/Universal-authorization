import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { posix } from 'node:path';
import JavaScriptObfuscator from 'javascript-obfuscator';
import { minify } from 'terser';
import { BuildEngine } from '../../../packages/ports/src/build-engine.js';
import { invariant } from '../../../packages/core/src/errors.js';
import { packageContentClaims, verifyPackageContent } from '../../../packages/core/src/package-content.js';
import { verifyCompactToken } from '../../../packages/core/src/signing.js';
import { readZip, writeZip } from '../../../packages/core/src/zip.js';
import { createBuildInjection } from './manifest.js';
import { assertProtectedGeneratedJavaScript, protectGeneratedJavaScript } from './generated-protection.js';
import { createBrowserLicenseRuntime } from './runtime.js';
import { initialLockMarkup, startupPresentationProfile } from './startup-presentation.js';
import { versionThemeAssets } from './license-page-adapter.js';
import { createXboardBridgePackage, xboardBridgeDescriptor } from './xboard-bridge-package.js';

const BLOCKED_EXTENSIONS = new Set(['.exe', '.dll', '.so', '.dylib', '.bat', '.cmd', '.ps1', '.sh', '.phar', '.jar']);
const BUILD_MANIFEST_SUFFIX = '/appgog-license/build.json';
const PROTECTED_IDENTITY_AAD = Buffer.from('APPGOG-PROTECTED-IDENTITY-v1');
const GENERATED_SOURCE_PATH_PATTERN = /(?:^|\/)appgog-license\/(?:build\.json|appgog-license-bridge\.zip|xboard-bridge-contract\.json|p-[^/]+\/)/i;
const GENERATED_SOURCE_TEXT_PATTERN = /APPGOG-(?:WM|PROTECTED):|data-appgog-license-runtime|appgog-initial-lock/;

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function manifestPathFor(files) {
  const matches = [...files.keys()].filter((name) => `/${name}`.endsWith(BUILD_MANIFEST_SUFFIX));
  invariant(matches.length === 1, 'PACKAGE_MANIFEST_MISSING', '成品必须包含且只能包含一个 APPGOG 构建清单', 409);
  return matches[0];
}

function fileIntegrityList(files, excludedPath) {
  return [...files.entries()]
    .filter(([name]) => name !== excludedPath)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, content]) => ({ path, bytes: content.length, sha256: sha256(content) }));
}

function integrityPayload(manifest, files) {
  return JSON.stringify({
    schema: manifest.schema,
    product: manifest.product,
    version: manifest.version,
    build_id: manifest.build_id,
    package_id: manifest.package_id,
    domain: manifest.domain,
    watermark: manifest.watermark,
    protection: manifest.protection,
    files,
  });
}

function integrityDigest(manifest, files, packageSecret) {
  return createHmac('sha256', packageSecret).update(integrityPayload(manifest, files), 'utf8').digest('hex');
}

function equalHex(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(left ?? '') || !/^[a-f0-9]{64}$/i.test(right ?? '')) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function assertPristineSource(files) {
  for (const [name, content] of files.entries()) {
    invariant(!GENERATED_SOURCE_PATH_PATTERN.test(name) && !/(?:^|\/)APPGOG-ACTIVATION\.txt$/i.test(name),
      'SOURCE_ALREADY_PROTECTED', `上传源包包含客户构建文件，必须改用原生态源码：${name}`, 409);
    const ext = extension(name);
    if (['.js', '.css', '.html', '.htm', '.php', '.json', '.txt'].includes(ext)) {
      invariant(!GENERATED_SOURCE_TEXT_PATTERN.test(content.toString('utf8')),
        'SOURCE_ALREADY_PROTECTED', `上传源包包含授权注入或混淆成品，必须改用原生态源码：${name}`, 409);
    }
  }
}

function protectIdentity(identity, packageSecret) {
  const key = createHash('sha256').update(packageSecret, 'utf8').digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(PROTECTED_IDENTITY_AAD);
  const plaintext = Buffer.from(JSON.stringify({ ...identity, nonce: randomBytes(24).toString('base64url') }), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope = Buffer.from(JSON.stringify({
    v: 1,
    a: 'AES-256-GCM',
    i: iv.toString('base64url'),
    c: encrypted.toString('base64url'),
    t: cipher.getAuthTag().toString('base64url'),
  }), 'utf8');
  return envelope;
}

function openProtectedIdentity(buffer, packageSecret) {
  try {
    const envelope = JSON.parse(buffer.toString('utf8'));
    invariant(envelope.v === 1 && envelope.a === 'AES-256-GCM', 'PACKAGE_PROTECTION_INVALID', '加密包身份格式无效', 409);
    const key = createHash('sha256').update(packageSecret, 'utf8').digest();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.i, 'base64url'));
    decipher.setAAD(PROTECTED_IDENTITY_AAD);
    decipher.setAuthTag(Buffer.from(envelope.t, 'base64url'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.c, 'base64url')), decipher.final()]).toString('utf8'));
  } catch (error) {
    if (error?.code === 'PACKAGE_PROTECTION_INVALID') throw error;
    invariant(false, 'PACKAGE_PROTECTION_INVALID', '加密包身份无法解密或已被篡改', 409);
  }
}

async function applyPerPackageSourceProtection(files, watermark) {
  const marker = `/* APPGOG-WM:${watermark} */\n`;
  const seed = Number.parseInt(createHash('sha256').update(watermark, 'utf8').digest('hex').slice(0, 8), 16);
  for (const [name, content] of [...files.entries()]) {
    const ext = extension(name);
    if (ext === '.map') {
      files.delete(name);
      continue;
    }
    if (ext !== '.js' && ext !== '.css') continue;
    const cleaned = content.toString('utf8')
      .replace(/\/\/[#@]\s*sourceMappingURL=.*?(?:\r?\n|$)/g, '')
      .replace(/\/\*[#@]\s*sourceMappingURL=.*?\*\//gs, '');
    if (ext === '.css') {
      const compact = cleaned.replace(/\/\*(?!\!)[\s\S]*?\*\//g, '').replace(/[\t\r\n]+/g, ' ').replace(/ {2,}/g, ' ').trim();
      files.set(name, Buffer.from(`${marker}${compact}`, 'utf8'));
      continue;
    }
    let protectedSource;
    try {
      const module = /(^|[;}]\s*)(?:import|export)\s/m.test(cleaned);
      protectedSource = await minify(cleaned, {
        compress: { passes: 2, drop_debugger: true },
        mangle: { toplevel: module, keep_classnames: true, keep_fnames: true },
        module,
        sourceMap: false,
        format: { comments: false, ascii_only: true, semicolons: true },
      });
    } catch (error) {
      invariant(false, 'SOURCE_JAVASCRIPT_PROTECTION_FAILED', `JavaScript 保护失败：${name}（${error?.message || '无法解析'}）`, 400);
    }
    invariant(typeof protectedSource?.code === 'string' && protectedSource.code.length > 0,
      'SOURCE_JAVASCRIPT_PROTECTION_FAILED', `JavaScript 保护失败：${name}`, 400);
    let obfuscated;
    try {
      obfuscated = JavaScriptObfuscator.obfuscate(protectedSource.code, {
        compact: true,
        controlFlowFlattening: false,
        deadCodeInjection: false,
        debugProtection: false,
        disableConsoleOutput: false,
        identifierNamesGenerator: 'hexadecimal',
        identifiersPrefix: `_appgog_${seed.toString(16)}_`,
        numbersToExpressions: true,
        renameGlobals: false,
        seed,
        selfDefending: false,
        simplify: true,
        splitStrings: true,
        splitStringsChunkLength: 8,
        stringArray: true,
        stringArrayEncoding: ['base64'],
        stringArrayIndexShift: true,
        stringArrayRotate: true,
        stringArrayShuffle: true,
        stringArrayThreshold: 1,
        transformObjectKeys: false,
        unicodeEscapeSequence: true,
      }).getObfuscatedCode();
    } catch (error) {
      invariant(false, 'SOURCE_JAVASCRIPT_PROTECTION_FAILED', `JavaScript 混淆失败：${name}（${error?.message || '未知错误'}）`, 400);
    }
    files.set(name, Buffer.from(`${marker}${obfuscated}`, 'utf8'));
  }
}

function extension(name) {
  const lower = name.toLowerCase();
  const index = lower.lastIndexOf('.');
  return index >= 0 ? lower.slice(index) : '';
}

function rootCandidates(files) {
  const candidates = [];
  for (const name of files.keys()) {
    const base = posix.basename(name).toLowerCase();
    if (base === 'index.html' || base === 'editor.html' || base === 'dashboard.blade.php') candidates.push(name);
  }
  return candidates;
}

function themeDescriptor(files, root) {
  const configPath = `${root}config.json`;
  invariant(files.has(configPath), 'SOURCE_CONFIG_NOT_FOUND', '主题根目录必须包含 Xboard config.json', 400);
  let descriptor;
  try {
    descriptor = JSON.parse(files.get(configPath).toString('utf8'));
  } catch {
    invariant(false, 'SOURCE_CONFIG_INVALID', 'Xboard 主题 config.json 无法解析', 400);
  }
  invariant(/^[A-Za-z0-9_-]{1,100}$/.test(descriptor?.name ?? ''),
    'SOURCE_THEME_NAME_INVALID', 'Xboard 主题名称只能包含字母、数字、下划线和中划线', 400);
  return descriptor;
}

function injectRuntime(html, runtimeSrc, marker, presentation) {
  invariant(!html.includes('data-appgog-license-runtime'), 'SOURCE_ALREADY_PROTECTED', '主题包已经包含 APPGOG 授权运行时', 409);
  // Lock before external scripts/network checks can expose the original editor.
  const initialLock = initialLockMarkup(presentation);
  if (/<head(?:\s[^>]*)?>/i.test(html)) html = html.replace(/<head(?:\s[^>]*)?>/i, (match) => match + initialLock);
  else html = initialLock + html;
  const tag = `<script data-appgog-license-runtime="${marker}" src="${runtimeSrc}"></script>`;
  if (/<\/head\s*>/i.test(html)) return html.replace(/<\/head\s*>/i, `${tag}</head>`);
  if (/<body(?:\s[^>]*)?>/i.test(html)) return html.replace(/<body(?:\s[^>]*)?>/i, (match) => `${tag}${match}`);
  return `${tag}${html}`;
}

export class HardenedThemeBuildEngine extends BuildEngine {
  constructor({
    artifactStore,
    publicKey,
    activationPublicKey = publicKey,
    packagePublicKey = publicKey,
    notificationPublicKey = publicKey,
    publicBaseUrl,
    bridgePackage = () => ({ buffer: createXboardBridgePackage(), descriptor: xboardBridgeDescriptor() }),
  }) {
    super();
    this.artifactStore = artifactStore;
    this.bridgePackage = bridgePackage;
    this.activationPublicKey = activationPublicKey;
    this.packagePublicKey = packagePublicKey;
    this.notificationPublicKey = notificationPublicKey;
    // Legacy alias kept for callers that still inspect the old property.
    this.publicKey = activationPublicKey;
    this.publicBaseUrl = publicBaseUrl;
  }

  validateSource(buffer, { allowProtected = false } = {}) {
    const files = readZip(buffer);
    invariant(files.size >= 2, 'SOURCE_EMPTY', '主题 ZIP 内容过少', 400);
    for (const name of files.keys()) {
      const ext = extension(name);
      invariant(!BLOCKED_EXTENSIONS.has(ext), 'SOURCE_EXECUTABLE_REJECTED', `主题 ZIP 含不允许的可执行文件：${name}`, 400);
      if (ext === '.php') invariant(name.toLowerCase().endsWith('.blade.php'), 'SOURCE_PHP_REJECTED', `只允许 Xboard Blade 模板，不允许普通 PHP：${name}`, 400);
    }
    const entries = rootCandidates(files);
    invariant(entries.length > 0, 'SOURCE_ENTRY_NOT_FOUND', '主题 ZIP 必须包含 index.html、editor.html 或 dashboard.blade.php', 400);
    const hasConfig = [...files.keys()].some((name) => posix.basename(name).toLowerCase() === 'config.json');
    invariant(hasConfig, 'SOURCE_CONFIG_NOT_FOUND', '主题 ZIP 必须包含 Xboard 主题 config.json', 400);
    if (!allowProtected) assertPristineSource(files);
    return { files, entries };
  }

  async build({ sourceRef, sourceBuffer: providedSourceBuffer, product, version, buildId, packageId, packageSecret, packageManifestToken, watermark, domain }) {
    const sourceInput = providedSourceBuffer ?? this.artifactStore.read(sourceRef);
    const sourceDigest = sha256(sourceInput);
    const sourceBuffer = Buffer.from(sourceInput);
    const { files, entries: primaryEntries } = this.validateSource(sourceBuffer);
    const entries = [...primaryEntries];
    const roots = entries.map((entry) => posix.dirname(entry)).sort((a, b) => a.length - b.length);
    const root = roots[0] === '.' ? '' : `${roots[0]}/`;
    // Development-only preview is not a customer entry. Other standalone HTML documents
    // are protected even when their names are not index/editor/dashboard.
    files.delete(root + 'preview-panel.html');
    for (const [path, content] of files) {
      if (/\.html?$/i.test(path) && !entries.includes(path) && /<!doctype\s+html|<html[\s>]|<script[\s>]/i.test(content.toString('utf8'))) entries.push(path);
    }
    const presentations = new Map(entries.map(entry => [entry, startupPresentationProfile(files, root, files.get(entry).toString('utf8'))]));
    versionThemeAssets(files, root, buildId);
    await applyPerPackageSourceProtection(files, watermark);
    const injection = createBuildInjection({
      product,
      version,
      buildId,
      packageId,
      packageSecret,
      packageManifestToken,
      watermark,
      licenseServer: this.publicBaseUrl,
      publicKey: this.activationPublicKey,
      activationPublicKey: this.activationPublicKey,
      packagePublicKey: this.packagePublicKey,
      notificationPublicKey: this.notificationPublicKey,
    });
    const theme = themeDescriptor(files, root);
    theme.appgog_activation = { schema: 1, entry: 'editor.html', bridge: 'appgog_license_bridge' };
    files.set(root + 'config.json', Buffer.from(JSON.stringify(theme, null, 2)));
    const pathSeed = createHmac('sha256', packageSecret).update(`appgog-paths:${packageId}:${watermark}`, 'utf8').digest('hex');
    const protectedRoot = `${root}appgog-license/p-${pathSeed.slice(0, 12)}/`;
    const runtimePath = `${protectedRoot}r-${pathSeed.slice(12, 28)}.js`;
    const protectedIdentityPath = `${protectedRoot}i-${pathSeed.slice(28, 44)}.bin`;
    const bridgeContractPath = `${root}appgog-license/xboard-bridge-contract.json`;
    const bridgePackagePath = `${root}appgog-license/appgog-license-bridge.zip`;
    const { buffer: bridgePackage, descriptor: bridgeDescriptor } = this.bridgePackage();
    const protectedIdentity = protectIdentity({ product, version, build_id: buildId, package_id: packageId, domain, watermark }, packageSecret);
    files.set(protectedIdentityPath, protectedIdentity);
    files.set(bridgePackagePath, bridgePackage);
    const runtime = createBrowserLicenseRuntime({
      injection,
      publicKeyPem: this.activationPublicKey,
      activationPublicKeyPem: this.activationPublicKey,
      packagePublicKeyPem: this.packagePublicKey,
      notificationPublicKeyPem: this.notificationPublicKey,
      protectedIdentity: { ref: posix.basename(protectedIdentityPath), sha256: sha256(protectedIdentity) },
      xboardBridge: {
        code: bridgeDescriptor.code,
        version: bridgeDescriptor.version,
        ref: posix.relative(posix.dirname(runtimePath), bridgePackagePath),
        sha256: sha256(bridgePackage),
        themeName: theme.name,
      },
    });
    files.set(runtimePath, Buffer.from(protectGeneratedJavaScript(runtime, packageId), 'utf8'));
    files.set(bridgeContractPath, Buffer.from(JSON.stringify({
      schema: 'appgog-xboard-bridge-v1',
      product, version, build_id: buildId, package_id: packageId,
      required_server_identity: 'Ed25519',
      plugin: {
        code: bridgeDescriptor.code,
        version: bridgeDescriptor.version,
        package_path: bridgePackagePath,
        package_sha256: sha256(bridgePackage),
        installation: 'xboard_admin_upload_install_enable',
        theme_name: theme.name,
      },
      persistent_state: [
        'storage/app/private/appgog-license-bridge/identity.json.enc',
        'storage/app/private/appgog-license-bridge/packages/*.json',
        'storage/app/private/appgog-license-bridge/state/*.json.enc',
      ],
      operations: {
        deactivate_and_remove_theme: {
          browser_hook: 'APPGOGThemeBridge.deactivateAndRemoveTheme',
          requirement: '先安全切回安装前主题，再删除当前未激活主题；禁止删除 Xboard 数据或其他主题',
        },
        recover_activation: {
          endpoint: '/api/v1/activations/recover',
          requirement: '必须使用原服务器安装私钥签署一次性 Challenge',
        },
        offline_license: {
          endpoint: '/api/v1/offline-licenses',
          requirement: '离线文件必须绑定 Installation ID、域名、Build 和 Package',
        },
        product_migration: {
          endpoint: '/api/v1/product-migrations',
          requirement: '目标服务器生成新 Installation ID；完成切换后旧服务器 Fenced',
        },
      },
    }, null, 2), 'utf8'));
    for (const entry of entries) {
      const html = files.get(entry).toString('utf8');
      const relative = posix.relative(posix.dirname(entry), runtimePath);
      // Blade is rendered at the site route, not at its ZIP directory. Xboard
      // publishes theme assets under config.name, independent of the ZIP wrapper.
      const runtimeSrc = entry.toLowerCase().endsWith('.blade.php')
        ? `/theme/${theme.name}/${posix.relative(root || '.', runtimePath)}`
        : (relative.startsWith('.') ? relative : `./${relative}`);
      files.set(entry, Buffer.from(injectRuntime(html, runtimeSrc, packageId, presentations.get(entry)), 'utf8'));
    }
    files.set(`${root}APPGOG-ACTIVATION.txt`, Buffer.from([
      'APPGOG 授权主题包',
      `版本: ${version}`,
      `授权域名: ${domain}`,
      `Build ID: ${buildId}`,
      `Package ID: ${packageId}`,
      '',
      '第一阶段：安装时只输入打包中心显示的一次性 Install Key，成功后该 Key 立即作废。',
      '第二阶段：首次进入 APPGOG 后台，只输入长期固定 License Key 完成正式激活。',
      '首次点击“开始激活”才启动 60 分钟窗口；刷新、退出和输错 Key 不会重置。',
      '主题首次从已登录的 Xboard 管理后台打开时，会自动上传、安装并启用 APPGOG License Bridge。',
      '服务端桥健康检查通过后才允许开始 60 分钟激活；失败时主题保持锁定且不会开始计时。',
      '安全删除、同机恢复、离线授权和服务器迁移均由服务端桥执行。',
    ].join('\r\n'), 'utf8'));
    const manifestPath = `${root}appgog-license/build.json`;
    const manifest = {
      schema: 2,
      product,
      version,
      build_id: buildId,
      package_id: packageId,
      domain,
      watermark,
      license_server: this.publicBaseUrl,
      package_manifest_token: packageManifestToken,
      verification_keys: { activation: this.activationPublicKey, package: this.packagePublicKey },
      protection: {
        profile: 'appgog-v1',
        identity_algorithm: 'AES-256-GCM',
        protected_identity_path: protectedIdentityPath,
        protected_identity_sha256: sha256(protectedIdentity),
        runtime_path: runtimePath,
        bridge_contract_path: bridgeContractPath,
        bridge_package_path: bridgePackagePath,
        bridge_package_sha256: sha256(bridgePackage),
        bridge_plugin_code: bridgeDescriptor.code,
        bridge_plugin_version: bridgeDescriptor.version,
        source_maps_removed: true,
        generated_javascript_protection: 'obfuscator-v1',
        protected_entries: entries,
        excluded_development_entries: [root + 'preview-panel.html'],
        javascript_protection: 'terser-obfuscator-v1',
        stylesheet_protection: 'comment-strip-compact-v1',
        source_watermark: watermark,
      },
      lifecycle: {
        install_window_seconds: 3600,
        reinstall: 'recover_with_original_installation_identity',
        domain_rebind: 'rebuild_after_self_service_domain_migration',
        server_migration: 'new_installation_identity_and_controlled_handoff',
        offline_license: 'signed_offline-license-v1',
      },
      created_at: new Date().toISOString(),
    };
    const integrityFiles = fileIntegrityList(files, manifestPath);
    manifest.integrity = {
      algorithm: 'HMAC-SHA256',
      files: integrityFiles,
      digest: integrityDigest(manifest, integrityFiles, packageSecret),
    };
    files.set(manifestPath, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    const output = writeZip(files);
    invariant(sha256(sourceInput) === sourceDigest, 'SOURCE_INPUT_MUTATED', '构建过程修改了上传源包，已停止交付', 409);
    if (!providedSourceBuffer) {
      invariant(sha256(this.artifactStore.read(sourceRef)) === sourceDigest,
        'SOURCE_INPUT_MUTATED', '构建后上传源包摘要发生变化，已停止交付', 409);
    }
    return {
      buffer: output,
      sha256: sha256(output),
      fileCount: files.size,
    };
  }

  sealArtifact({ buffer, packageSecret, expected, signContent }) {
    this.verifyArtifact({ buffer, packageSecret, expected, allowUnsignedDraft: true });
    const files = readZip(buffer);
    const path = manifestPathFor(files);
    const manifest = JSON.parse(files.get(path));
    manifest.content_signature = signContent(packageContentClaims(manifest, expected.issuer));
    files.set(path, Buffer.from(JSON.stringify(manifest, null, 2)));
    const sealed = writeZip(files);
    this.verifyArtifact({ buffer: sealed, packageSecret, expected });
    return { buffer: sealed, sha256: sha256(sealed) };
  }

  verifyArtifact({ buffer, packageSecret, expected, allowUnsignedDraft = false }) {
    const { files } = this.validateSource(buffer, { allowProtected: true });
    const manifestPath = manifestPathFor(files);
    let manifest;
    try {
      manifest = JSON.parse(files.get(manifestPath).toString('utf8'));
    } catch {
      invariant(false, 'PACKAGE_MANIFEST_INVALID', '成品构建清单无法解析', 409);
    }
    invariant(manifest.schema === 2, 'PACKAGE_MANIFEST_SCHEMA_INVALID', '成品构建清单版本无效', 409);
    invariant(manifest.integrity?.algorithm === 'HMAC-SHA256', 'PACKAGE_INTEGRITY_INVALID', '成品完整性算法无效', 409);
    invariant(Array.isArray(manifest.integrity.files), 'PACKAGE_INTEGRITY_INVALID', '成品文件摘要清单无效', 409);
    invariant(typeof manifest.package_manifest_token === 'string', 'PACKAGE_MANIFEST_TOKEN_MISSING', '成品缺少签名包身份', 409);
    invariant(manifest.protection?.profile === 'appgog-v1' && manifest.protection.identity_algorithm === 'AES-256-GCM',
      'PACKAGE_PROTECTION_INVALID', '成品缺少 APPGOG v1 加密保护信息', 409);
    invariant(manifest.protection.generated_javascript_protection === 'obfuscator-v1',
      'PACKAGE_PROTECTION_INVALID', '成品缺少生成授权脚本保护声明', 409);
    invariant(typeof manifest.protection.protected_identity_path === 'string' && typeof manifest.protection.runtime_path === 'string',
      'PACKAGE_PROTECTION_INVALID', '成品保护路径无效', 409);
    invariant(typeof manifest.protection.bridge_package_path === 'string'
      && typeof manifest.protection.bridge_package_sha256 === 'string',
    'PACKAGE_PROTECTION_INVALID', '成品缺少 Xboard 授权桥插件信息', 409);

    const identityFields = ['product', 'version', 'build_id', 'package_id', 'domain', 'watermark'];
    for (const field of identityFields) {
      invariant(manifest[field] === expected[field], 'BUILD_RESULT_MISMATCH', `成品构建身份字段 ${field} 不匹配`, 409);
    }
    const signed = verifyCompactToken(manifest.package_manifest_token, this.packagePublicKey);
    invariant(signed.typ === 'package-manifest', 'PACKAGE_MANIFEST_TOKEN_INVALID', '签名包身份类型无效', 409);
    invariant(signed.iss === expected.issuer, 'PACKAGE_MANIFEST_TOKEN_INVALID', '签名包身份签发方不匹配', 409);
    for (const field of identityFields) {
      invariant(signed[field] === expected[field], 'PACKAGE_MANIFEST_TOKEN_INVALID', `签名包身份字段 ${field} 不匹配`, 409);
    }
    const protectedIdentity = files.get(manifest.protection.protected_identity_path);
    const bridgePackage = files.get(manifest.protection.bridge_package_path);
    invariant(protectedIdentity && bridgePackage && files.has(manifest.protection.runtime_path),
      'PACKAGE_PROTECTION_MISSING', '成品缺少加密包身份、授权运行时或 Xboard 授权桥插件', 409);
    invariant(equalHex(manifest.protection.protected_identity_sha256, sha256(protectedIdentity)),
      'PACKAGE_PROTECTION_INVALID', '加密包身份摘要不匹配', 409);
    invariant(equalHex(manifest.protection.bridge_package_sha256, sha256(bridgePackage)),
      'PACKAGE_PROTECTION_INVALID', 'Xboard 授权桥插件摘要不匹配', 409);
    assertProtectedGeneratedJavaScript(
      files.get(manifest.protection.runtime_path).toString('utf8'), manifest.package_id, '授权运行时',
    );
    let bridgeFiles;
    try {
      bridgeFiles = readZip(bridgePackage);
    } catch {
      invariant(false, 'PACKAGE_BRIDGE_INVALID', 'Xboard 授权桥 ZIP 无法读取', 409);
    }
    const bridgeDescriptors = [...bridgeFiles.entries()].filter(([path]) => path.endsWith('/config.json'));
    invariant(bridgeDescriptors.length === 1, 'PACKAGE_BRIDGE_INVALID', 'Xboard 授权桥配置文件无效', 409);
    let actualBridgeDescriptor;
    try {
      actualBridgeDescriptor = JSON.parse(bridgeDescriptors[0][1].toString('utf8'));
    } catch {
      invariant(false, 'PACKAGE_BRIDGE_INVALID', 'Xboard 授权桥配置无法解析', 409);
    }
    invariant(actualBridgeDescriptor.code === manifest.protection.bridge_plugin_code
      && actualBridgeDescriptor.version === manifest.protection.bridge_plugin_version,
    'PACKAGE_BRIDGE_INVALID', 'Xboard 授权桥身份与成品清单不一致', 409);
    const bridgeScripts = [...bridgeFiles.entries()].filter(([path]) => extension(path) === '.js');
    invariant(bridgeScripts.length > 0, 'PACKAGE_BRIDGE_INVALID', 'Xboard 授权桥缺少受保护的前端脚本', 409);
    for (const [path, content] of bridgeScripts) {
      assertProtectedGeneratedJavaScript(
        content.toString('utf8'), `${actualBridgeDescriptor.version}:${path}`, `Xboard 授权桥脚本 ${path}`,
      );
    }
    for (const [path, content] of bridgeFiles.entries()) {
      invariant(extension(path) !== '.map', 'PACKAGE_SOURCE_MAP_FORBIDDEN', 'Xboard 授权桥不得包含 Source Map', 409);
      if (extension(path) === '.js') {
        invariant(!/[#@]\s*sourceMappingURL=/.test(content.toString('utf8')),
          'PACKAGE_SOURCE_MAP_FORBIDDEN', 'Xboard 授权桥不得引用 Source Map', 409);
      }
    }
    const protectedClaims = openProtectedIdentity(protectedIdentity, packageSecret);
    for (const field of identityFields) {
      invariant(protectedClaims[field] === expected[field], 'PACKAGE_PROTECTION_INVALID', `加密包身份字段 ${field} 不匹配`, 409);
    }
    for (const [path, content] of files.entries()) {
      invariant(extension(path) !== '.map', 'PACKAGE_SOURCE_MAP_FORBIDDEN', '成品不得包含 Source Map', 409);
      if (['.js', '.css'].includes(extension(path))) {
        invariant(!/[#@]\s*sourceMappingURL=/.test(content.toString('utf8')), 'PACKAGE_SOURCE_MAP_FORBIDDEN', '成品不得引用 Source Map', 409);
      }
    }

    const actualFiles = fileIntegrityList(files, manifestPath);
    invariant(JSON.stringify(manifest.integrity.files) === JSON.stringify(actualFiles), 'PACKAGE_FILES_TAMPERED', '成品文件摘要与实际内容不一致', 409);
    const digest = integrityDigest(manifest, actualFiles, packageSecret);
    invariant(equalHex(manifest.integrity.digest, digest), 'PACKAGE_HMAC_INVALID', '成品 Package Secret 完整性校验失败', 409);
    if (signed.content_signature_required === true || manifest.content_signature) {
      if (!(allowUnsignedDraft && !manifest.content_signature)) verifyPackageContent(manifest, this.packagePublicKey, expected.issuer);
    }
    return { manifest, manifestPath, files: actualFiles };
  }
}

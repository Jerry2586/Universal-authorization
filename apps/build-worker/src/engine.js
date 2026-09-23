import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { posix } from 'node:path';
import { BuildEngine } from '../../../packages/ports/src/build-engine.js';
import { invariant } from '../../../packages/core/src/errors.js';
import { verifyCompactToken } from '../../../packages/core/src/signing.js';
import { readZip, writeZip } from '../../../packages/core/src/zip.js';
import { createBuildInjection } from './manifest.js';
import { createBrowserLicenseRuntime } from './runtime.js';

const BLOCKED_EXTENSIONS = new Set(['.exe', '.dll', '.so', '.dylib', '.bat', '.cmd', '.ps1', '.sh', '.phar', '.jar']);
const BUILD_MANIFEST_SUFFIX = '/appgog-license/build.json';
const PROTECTED_IDENTITY_AAD = Buffer.from('APPGOG-PROTECTED-IDENTITY-v1');

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

function applyPerPackageSourceProtection(files, watermark) {
  const marker = `/* APPGOG-WM:${watermark} */\n`;
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
    files.set(name, Buffer.from(`${marker}${cleaned}`, 'utf8'));
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

  async build({ sourceRef, sourceBuffer: providedSourceBuffer, product, version, buildId, packageId, packageSecret, packageManifestToken, watermark, domain }) {
    const sourceBuffer = providedSourceBuffer ?? this.artifactStore.read(sourceRef);
    const { files, entries } = this.validateSource(sourceBuffer);
    applyPerPackageSourceProtection(files, watermark);
    const injection = createBuildInjection({
      product,
      version,
      buildId,
      packageId,
      packageSecret,
      packageManifestToken,
      watermark,
      licenseServer: this.publicBaseUrl,
      publicKey: this.publicKey,
    });
    const roots = entries.map((entry) => posix.dirname(entry)).sort((a, b) => a.length - b.length);
    const root = roots[0] === '.' ? '' : `${roots[0]}/`;
    const pathSeed = createHmac('sha256', packageSecret).update(`appgog-paths:${packageId}:${watermark}`, 'utf8').digest('hex');
    const protectedRoot = `${root}appgog-license/p-${pathSeed.slice(0, 12)}/`;
    const runtimePath = `${protectedRoot}r-${pathSeed.slice(12, 28)}.js`;
    const protectedIdentityPath = `${protectedRoot}i-${pathSeed.slice(28, 44)}.bin`;
    const protectedIdentity = protectIdentity({ product, version, build_id: buildId, package_id: packageId, domain, watermark }, packageSecret);
    files.set(protectedIdentityPath, protectedIdentity);
    const runtime = createBrowserLicenseRuntime({
      injection,
      publicKeyPem: this.publicKey,
      protectedIdentity: { ref: posix.basename(protectedIdentityPath), sha256: sha256(protectedIdentity) },
    });
    files.set(runtimePath, Buffer.from(runtime, 'utf8'));
    for (const entry of entries) {
      const html = files.get(entry).toString('utf8');
      const relative = posix.relative(posix.dirname(entry), runtimePath);
      const runtimeSrc = relative.startsWith('.') ? relative : `./${relative}`;
      files.set(entry, Buffer.from(injectRuntime(html, runtimeSrc, packageId), 'utf8'));
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
      protection: {
        profile: 'appgog-v1',
        identity_algorithm: 'AES-256-GCM',
        protected_identity_path: protectedIdentityPath,
        protected_identity_sha256: sha256(protectedIdentity),
        runtime_path: runtimePath,
        source_maps_removed: true,
        source_watermark: watermark,
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
    return {
      buffer: output,
      sha256: sha256(output),
      fileCount: files.size,
    };
  }

  verifyArtifact({ buffer, packageSecret, expected }) {
    const { files } = this.validateSource(buffer);
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
    invariant(typeof manifest.protection.protected_identity_path === 'string' && typeof manifest.protection.runtime_path === 'string',
      'PACKAGE_PROTECTION_INVALID', '成品保护路径无效', 409);

    const identityFields = ['product', 'version', 'build_id', 'package_id', 'domain', 'watermark'];
    for (const field of identityFields) {
      invariant(manifest[field] === expected[field], 'BUILD_RESULT_MISMATCH', `成品构建身份字段 ${field} 不匹配`, 409);
    }
    const signed = verifyCompactToken(manifest.package_manifest_token, this.publicKey);
    invariant(signed.typ === 'package-manifest', 'PACKAGE_MANIFEST_TOKEN_INVALID', '签名包身份类型无效', 409);
    invariant(signed.iss === expected.issuer, 'PACKAGE_MANIFEST_TOKEN_INVALID', '签名包身份签发方不匹配', 409);
    for (const field of identityFields) {
      invariant(signed[field] === expected[field], 'PACKAGE_MANIFEST_TOKEN_INVALID', `签名包身份字段 ${field} 不匹配`, 409);
    }
    const protectedIdentity = files.get(manifest.protection.protected_identity_path);
    invariant(protectedIdentity && files.has(manifest.protection.runtime_path), 'PACKAGE_PROTECTION_MISSING', '成品缺少加密包身份或授权运行时', 409);
    invariant(equalHex(manifest.protection.protected_identity_sha256, sha256(protectedIdentity)),
      'PACKAGE_PROTECTION_INVALID', '加密包身份摘要不匹配', 409);
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
    return { manifest, manifestPath, files: actualFiles };
  }
}

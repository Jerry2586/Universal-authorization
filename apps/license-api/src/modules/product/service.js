import { invariant } from '../../../../../packages/core/src/errors.js';
import { newId } from '../../../../../packages/core/src/identifiers.js';
import { SOURCE_KIND } from '../../../../../packages/contracts/src/build-job.js';

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const ACCESS_TIERS = new Set(['free', 'paid']);

function normalizedAccessTier(value) {
  const accessTier = String(value ?? 'free').trim().toLowerCase();
  invariant(ACCESS_TIERS.has(accessTier), 'VERSION_ACCESS_TIER_INVALID', '发布权限必须是免费授权可用或仅付费授权可用');
  return accessTier;
}

function versionFromName(value) {
  const text = String(value ?? '').replace(/\.zip$/i, '');
  if (!/appgog/i.test(text)) return null;
  return text.match(/(?:^|[-_\s])v?(\d+\.\d+\.\d+)(?:$|[-_\s])/i)?.[1] ?? null;
}

function sourceMetadata(files, sourceFilename) {
  const configPaths = [...files.keys()]
    .filter((name) => name.split('/').at(-1)?.toLowerCase() === 'config.json')
    .sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right));
  let config = {};
  if (configPaths.length) {
    try { config = JSON.parse(files.get(configPaths[0]).toString('utf8')); }
    catch { invariant(false, 'SOURCE_CONFIG_INVALID', '主题 config.json 不是有效 JSON', 400); }
  }
  const configVersion = [config.version, config.theme?.version, config.appgog?.version]
    .find((value) => typeof value === 'string' && VERSION_PATTERN.test(value.trim()))?.trim() ?? null;
  const roots = [...new Set([...files.keys()].map((name) => name.split('/')[0]).filter(Boolean))];
  const uniqueNameVersions = [...new Set([sourceFilename, ...roots].map(versionFromName).filter(Boolean))];
  invariant(uniqueNameVersions.length <= 1, 'SOURCE_VERSION_CONFLICT', 'ZIP 文件名与根目录中的版本号不一致，请检查后重新上传', 409);
  const nameVersion = uniqueNameVersions[0] ?? null;
  invariant(!configVersion || !nameVersion || configVersion === nameVersion,
    'SOURCE_VERSION_CONFLICT', 'config.json 与 ZIP 文件名或根目录中的版本号不一致', 409);
  const version = configVersion ?? nameVersion;
  const configuredName = [config.display_name, config.displayName, config.theme?.display_name, config.theme?.name, config.name]
    .find((value) => typeof value === 'string' && value.trim())?.trim() ?? null;
  const displayName = version ? (configuredName
    ? (configuredName.includes(version) ? configuredName : `${configuredName} ${version}`)
    : `APPGOG ${version}`) : configuredName;
  return { version, displayName };
}

export function createProductService({ repository, productCatalog, artifactStore, buildEngine, config, clock = () => new Date() }) {
  return Object.freeze({
    registerSourceVersion({ productCode = 'appgog', version, displayName, releaseNotes, channel, releaseKind, accessTier }) {
      invariant(version?.trim(), 'VERSION_REQUIRED', '必须填写版本号');
      const product = productCatalog.ensureProduct({ code: productCode, name: productCode.toUpperCase() });
      invariant(!repository.sourceVersionByProductVersion(product.code, version.trim()), 'VERSION_EXISTS', '该版本已经存在', 409);
      return repository.createSourceVersion({
        productId: product.id,
        version: version.trim(),
        displayName: displayName?.trim() || `APPGOG ${version.trim()}`,
        sourceKind: SOURCE_KIND.OFFICIAL,
        sourceRef: null,
        status: 'draft',
        releaseNotes, channel, releaseKind, accessTier: normalizedAccessTier(accessTier),
        rollbackAllowed: false, rollbackTo: null,
        now: clock().toISOString(),
      });
    },

    publishSourceVersion({
      productCode = 'appgog', version, displayName, sourceFilename, zipBuffer,
      releaseNotes, channel, releaseKind, accessTier, actorId = null,
    }) {
      invariant(Buffer.isBuffer(zipBuffer) && zipBuffer.length > 0, 'SOURCE_REQUIRED', '必须上传主题 ZIP');
      invariant(zipBuffer.length <= config.maxSourceUploadBytes, 'SOURCE_TOO_LARGE', '上传的主题 ZIP 超出大小限制', 413);
      const validation = buildEngine.validateSource(zipBuffer);
      const detected = sourceMetadata(validation.files, sourceFilename);
      const product = productCatalog.ensureProduct({ code: productCode, name: productCode.toUpperCase() });
      const requestedVersion = version?.trim() || null;
      invariant(!requestedVersion || !detected.version || requestedVersion === detected.version,
        'SOURCE_VERSION_CONFLICT', `填写的版本号与安装包识别结果 ${detected.version} 不一致`, 409);
      const normalizedVersion = requestedVersion ?? detected.version;
      invariant(normalizedVersion, 'VERSION_REQUIRED', '无法自动识别版本号，请手动填写后重试');
      invariant(VERSION_PATTERN.test(normalizedVersion), 'VERSION_INVALID', '版本号格式无效，请使用例如 1.8.11 的格式');
      const normalizedDisplayName = displayName?.trim() || detected.displayName || `APPGOG ${normalizedVersion}`;
      const normalizedTier = normalizedAccessTier(accessTier);
      const existing = repository.sourceVersionByProductVersion(product.code, normalizedVersion);
      invariant(!existing || existing.status === 'draft', 'VERSION_EXISTS', '该版本已经发布', 409);
      const versionId = existing?.id ?? newId('src');
      const sourceRef = `sources/${product.code}/${normalizedVersion.replace(/[^a-zA-Z0-9._-]/g, '_')}/${versionId}.zip`;
      artifactStore.put(sourceRef, zipBuffer);
      try {
        const values = {
          id: versionId, productId: product.id, version: normalizedVersion,
          displayName: normalizedDisplayName, sourceKind: SOURCE_KIND.OFFICIAL, sourceRef,
          status: 'active', releaseNotes, channel, releaseKind, accessTier: normalizedTier,
          rollbackAllowed: false, rollbackTo: null, now: clock().toISOString(),
        };
        const source = existing ? repository.publishSourceVersion(values) : repository.createSourceVersion(values);
        invariant(source, 'VERSION_PUBLISH_CONFLICT', '版本状态已发生变化，请刷新后重试', 409);
        repository.audit({
          actorType: 'admin', actorId, action: 'source_version.published',
          subjectType: 'source_version', subjectId: source.id,
          metadata: {
            version: source.version, display_name: source.display_name,
            source_filename: sourceFilename ?? null, source_ref: sourceRef, size: zipBuffer.length,
            access_tier: source.access_tier,
          },
          now: clock().toISOString(),
        });
        return source;
      } catch (error) {
        artifactStore.remove(sourceRef);
        throw error;
      }
    },

    withdrawSourceVersion({ id, reason, actorId }) {
      invariant(typeof reason === 'string' && reason.trim().length >= 8, 'WITHDRAW_REASON_REQUIRED', '撤回原因至少 8 个字');
      const version = repository.withdrawSourceVersion(id, reason.trim());
      invariant(version, 'VERSION_WITHDRAW_CONFLICT', '版本不存在或不是已发布状态', 409);
      repository.audit({
        actorType: 'admin', actorId, action: 'source_version.withdrawn',
        subjectType: 'source_version', subjectId: id,
        metadata: { version: version.version, reason: reason.trim() }, now: clock().toISOString(),
      });
      return version;
    },
  });
}

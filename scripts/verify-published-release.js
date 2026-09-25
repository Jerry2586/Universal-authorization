import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPackagedArtifacts } from './verify-release-contract.js';

const DEFAULT_REPOSITORY = 'Jerry2586/Universal-authorization';
const DEFAULT_API_BASE = 'https://api.github.com';

function requirePublished(condition, message) {
  if (!condition) throw new Error(`已发布版本校验失败：${message}`);
}

function releaseAssetNames(version) {
  const releaseName = `APPGOG-Packaging-Licensing-System-${version}`;
  return [
    `${releaseName}.zip`,
    `${releaseName}.zip.sha256`,
    `${releaseName}.run`,
    `${releaseName}.run.sha256`,
    'install.sh',
    'release-manifest.json',
    'release-manifest.json.sig',
  ];
}

async function requestJson(fetchFn, url, token) {
  const response = await fetchFn(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'appgog-release-verifier',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  requirePublished(response.ok, `GitHub API 请求失败 ${response.status}：${url}`);
  return response.json();
}

async function downloadAsset(fetchFn, asset, target, token) {
  requirePublished(typeof asset.browser_download_url === 'string' && asset.browser_download_url.length > 0,
    `附件 ${asset.name} 缺少 browser_download_url`);
  const response = await fetchFn(asset.browser_download_url, {
    headers: {
      Accept: 'application/octet-stream',
      'User-Agent': 'appgog-release-verifier',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  requirePublished(response.ok, `附件下载失败 ${response.status}：${asset.name}`);
  writeFileSync(target, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
}

export async function verifyPublishedRelease({
  tag,
  repository = DEFAULT_REPOSITORY,
  apiBase = DEFAULT_API_BASE,
  outputDirectory,
  allowNotLatest = false,
  keepDownloads = false,
  fetchFn = globalThis.fetch,
  token = process.env.GITHUB_TOKEN,
  publicKeyPem,
} = {}) {
  requirePublished(typeof fetchFn === 'function', '当前 Node.js 环境不支持 fetch');
  requirePublished(/^v\d+\.\d+\.\d+$/.test(tag ?? ''), '必须通过 --tag 提供 vX.Y.Z 正式标签');
  requirePublished(/^[^/]+\/[^/]+$/.test(repository), '仓库必须使用 owner/name 格式');
  const version = tag.slice(1);
  const encodedTag = encodeURIComponent(tag);
  const base = apiBase.replace(/\/$/, '');
  const release = await requestJson(fetchFn, `${base}/repos/${repository}/releases/tags/${encodedTag}`, token);
  requirePublished(release.tag_name === tag, `Release 标签 ${release.tag_name} 与 ${tag} 不一致`);
  requirePublished(release.draft === false, `${tag} 仍是草稿`);
  requirePublished(release.prerelease === false, `${tag} 被标记为预发布`);

  if (!allowNotLatest) {
    const latest = await requestJson(fetchFn, `${base}/repos/${repository}/releases/latest`, token);
    requirePublished(latest.id === release.id && latest.tag_name === tag,
      `Latest Release 是 ${latest.tag_name ?? '未知'}，不是 ${tag}`);
  }

  const expectedNames = releaseAssetNames(version);
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const actualNames = assets.map((asset) => asset.name);
  requirePublished(assets.length === expectedNames.length,
    `附件数量应为 ${expectedNames.length}，实际为 ${assets.length}`);
  requirePublished(new Set(actualNames).size === actualNames.length, 'Release 存在重名附件');
  requirePublished(expectedNames.every((name) => actualNames.includes(name))
    && actualNames.every((name) => expectedNames.includes(name)),
  `附件名称不匹配；期望 ${expectedNames.join(', ')}；实际 ${actualNames.join(', ')}`);

  const temporary = !outputDirectory;
  const directory = outputDirectory ? resolve(outputDirectory) : mkdtempSync(join(tmpdir(), 'appgog-release-'));
  mkdirSync(directory, { recursive: true });
  try {
    for (const name of expectedNames) {
      const asset = assets.find((candidate) => candidate.name === name);
      await downloadAsset(fetchFn, asset, join(directory, basename(name)), token);
    }
    const manifest = verifyPackagedArtifacts({
      artifactDirectory: directory,
      expectedVersion: version,
      publicKeyPem,
    });
    console.log(`GitHub Release 回下载校验通过：${tag} / 7 个附件 / Latest=${allowNotLatest ? '未要求' : '是'}`);
    return { release, manifest, directory };
  } finally {
    if (temporary && !keepDownloads) rmSync(directory, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--allow-not-latest') options.allowNotLatest = true;
    else if (argument === '--keep-downloads') options.keepDownloads = true;
    else if (['--tag', '--repo', '--api-base', '--output'].includes(argument)) {
      const value = argv[index + 1];
      requirePublished(value && !value.startsWith('--'), `${argument} 缺少参数`);
      index += 1;
      if (argument === '--tag') options.tag = value;
      if (argument === '--repo') options.repository = value;
      if (argument === '--api-base') options.apiBase = value;
      if (argument === '--output') options.outputDirectory = value;
    } else throw new Error(`未知参数：${argument}`);
  }
  return options;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  verifyPublishedRelease(parseArguments(process.argv.slice(2))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

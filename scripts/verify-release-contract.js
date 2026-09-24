import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip } from '../packages/core/src/zip.js';

const root = resolve(import.meta.dirname, '..');

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function json(path) {
  return JSON.parse(read(path));
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(`发布合同校验失败：${message}`);
}

function capture(contents, pattern, description) {
  const match = contents.match(pattern);
  requireCondition(match, `无法从 ${description} 读取配置`);
  return match[1];
}

function checksum(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function loadReleaseContext() {
  const packageManifest = json('package.json');
  const contract = json('release-contract.json');
  return { packageManifest, contract, version: packageManifest.version };
}

export function verifySourceContract() {
  const { packageManifest, contract, version } = loadReleaseContext();
  requireCondition(/^\d+\.\d+\.\d+$/.test(version), `package.json 版本 ${version} 不是正式语义版本`);
  requireCondition(contract.schema === 1 && contract.product === 'appgog', 'release-contract.json schema/product 无效');
  requireCondition(packageManifest.engines?.node === contract.node_engine, 'package.json Node 引擎与 release-contract.json 不一致');
  requireCondition(Number(capture(contract.node_engine, /^>=([0-9]+)$/, 'release-contract.json node_engine')) === contract.node_major, 'Node 引擎与 node_major 不一致');
  requireCondition(/^\d+\.\d+$/.test(contract.docker_compose_min), '最低 Docker Compose 版本格式无效');
  requireCondition(JSON.stringify(contract.architectures) === JSON.stringify(['amd64', 'arm64']), '正式安装包必须同时支持 amd64 与 arm64');

  const dockerfile = read('Dockerfile');
  requireCondition(capture(dockerfile, /^ARG NODE_IMAGE=(.+)$/m, 'Dockerfile NODE_IMAGE') === contract.node_image, 'Dockerfile Node 镜像不匹配');
  requireCondition(capture(dockerfile, /^ARG CADDY_IMAGE=(.+)$/m, 'Dockerfile CADDY_IMAGE') === contract.caddy_image, 'Dockerfile Caddy 镜像不匹配');

  const compose = read('compose.yaml');
  requireCondition(compose.includes(`APPGOG_NODE_IMAGE:-${contract.node_image}`), 'compose.yaml Node 镜像不匹配');
  requireCondition(compose.includes(`APPGOG_CADDY_IMAGE:-${contract.caddy_image}`), 'compose.yaml Caddy 镜像不匹配');

  const dockerEnv = read('.env.docker.example');
  requireCondition(dockerEnv.includes(`APPGOG_NODE_IMAGE=${contract.node_image}`), '.env.docker.example Node 镜像不匹配');
  requireCondition(dockerEnv.includes(`APPGOG_CADDY_IMAGE=${contract.caddy_image}`), '.env.docker.example Caddy 镜像不匹配');

  const installer = read('scripts/install-linux.sh');
  requireCondition(installer.includes(`NODE_IMAGE=\${APPGOG_NODE_IMAGE:-${contract.node_image}}`), 'Linux 安装器 Node 镜像不匹配');
  requireCondition(installer.includes(`CADDY_IMAGE=\${APPGOG_CADDY_IMAGE:-${contract.caddy_image}}`), 'Linux 安装器 Caddy 镜像不匹配');
  const composeMinor = Number(contract.docker_compose_min.split('.')[1]);
  requireCondition(installer.includes(`[ "$minor" -ge ${composeMinor} ]`), 'Linux 安装器最低 Compose 版本不匹配');
  requireCondition(read('scripts/docker.sh').includes(`[ "$minor" -ge ${composeMinor} ]`), 'Docker 管理脚本最低 Compose 版本不匹配');

  const workflow = read('.github/workflows/docker.yml');
  requireCondition(Number(capture(workflow, /node-version:\s*['"]?([0-9]+)/, 'GitHub Actions node-version')) === contract.node_major, 'GitHub Actions Node 主版本不匹配');
  requireCondition(workflow.includes('node scripts/verify-release-contract.js --source'), 'GitHub Actions 缺少源文件发布合同检查');
  requireCondition(workflow.includes('node scripts/verify-release-contract.js --artifacts'), 'GitHub Actions 缺少安装包发布合同检查');

  requireCondition(read('README.md').startsWith(`# APPGOG打包授权系统 v${version}\n`), 'README 标题版本不匹配');
  requireCondition(read('docs/architecture.md').startsWith(`# APPGOG打包授权系统架构（v${version}）\n`), '架构文档版本不匹配');
  requireCondition(read('docs/deployment.md').includes(`APPGOG打包授权系统 v${version} 的正式生产路线`), '部署文档版本不匹配');
  const notesPath = `docs/release-notes-v${version}.md`;
  requireCondition(existsSync(join(root, notesPath)), `缺少 ${notesPath}`);
  requireCondition(read(notesPath).startsWith(`# APPGOG打包授权系统 v${version}\n`), 'Release Notes 标题版本不匹配');
  requireCondition(read('AGENTS.md').includes('环境与安装包必须作为一个版本更新'), 'AGENTS.md 缺少强制发布规则');
  requireCondition(read('docs/release-policy.md').includes('APPGOG 强制升级与发布标准'), '缺少正式发布标准文档');

  console.log(`发布合同源文件校验通过：APPGOG v${version} / Node ${contract.node_major} / ${contract.node_image} / ${contract.caddy_image}`);
  return { packageManifest, contract, version };
}

export function verifyPackagedArtifacts() {
  const { packageManifest, contract, version } = verifySourceContract();
  const dist = join(root, 'dist');
  const releaseName = `APPGOG-Packaging-Licensing-System-${version}`;
  const zipPath = join(dist, `${releaseName}.zip`);
  const runPath = join(dist, `${releaseName}.run`);
  const manifestPath = join(dist, 'release-manifest.json');
  for (const path of [zipPath, `${zipPath}.sha256`, runPath, `${runPath}.sha256`, join(dist, 'install.sh'), manifestPath]) {
    requireCondition(existsSync(path), `缺少发布附件 ${basename(path)}`);
  }

  const releaseManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  requireCondition(releaseManifest.schema === 2 && releaseManifest.product === contract.product, '发布清单 schema/product 不匹配');
  requireCondition(releaseManifest.version === version, '发布清单版本不匹配');
  requireCondition(releaseManifest.zip_name === `${releaseName}.zip`, 'ZIP 文件名与版本不匹配');
  requireCondition(releaseManifest.run_name === `${releaseName}.run`, 'RUN 文件名与版本不匹配');
  requireCondition(releaseManifest.zip_sha256 === checksum(zipPath), 'ZIP SHA-256 与发布清单不匹配');
  requireCondition(releaseManifest.run_sha256 === checksum(runPath), 'RUN SHA-256 与发布清单不匹配');
  requireCondition(JSON.stringify(releaseManifest.environment) === JSON.stringify(contract), '签名发布清单中的环境合同不匹配');
  requireCondition(readFileSync(`${zipPath}.sha256`, 'utf8') === `${releaseManifest.zip_sha256}  ${releaseManifest.zip_name}\n`, 'ZIP SHA-256 文件内容不匹配');
  requireCondition(readFileSync(`${runPath}.sha256`, 'utf8') === `${releaseManifest.run_sha256}  ${releaseManifest.run_name}\n`, 'RUN SHA-256 文件内容不匹配');
  requireCondition(readFileSync(join(dist, 'install.sh'), 'utf8') === read('install-docker.sh').replaceAll('\r\n', '\n'), 'dist/install.sh 与稳定引导器不一致');

  const files = readZip(readFileSync(zipPath), { maxEntries: 1000, maxSingleFileBytes: 32 * 1024 * 1024, maxUncompressedBytes: 256 * 1024 * 1024 });
  const packaged = (path) => files.get(`${releaseName}/${path}`);
  for (const path of ['AGENTS.md', 'release-contract.json', 'docs/release-policy.md', 'package.json', 'Dockerfile', 'compose.yaml', 'scripts/install-linux.sh']) {
    requireCondition(packaged(path), `正式 ZIP 缺少 ${path}`);
  }
  requireCondition(JSON.parse(packaged('package.json').toString('utf8')).version === version, '正式 ZIP 内 package.json 版本不匹配');
  requireCondition(JSON.stringify(JSON.parse(packaged('release-contract.json').toString('utf8'))) === JSON.stringify(contract), '正式 ZIP 内环境合同不匹配');
  requireCondition(packageManifest.version === version, '打包过程中 package.json 版本发生变化');

  console.log(`发布合同安装包校验通过：${releaseManifest.run_name}`);
  return releaseManifest;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  const mode = process.argv[2] ?? '--source';
  if (mode === '--source') verifySourceContract();
  else if (mode === '--artifacts') verifyPackagedArtifacts();
  else throw new Error('用法：node scripts/verify-release-contract.js --source|--artifacts');
}

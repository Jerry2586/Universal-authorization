import { createHash, verify } from 'node:crypto';
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
  for (const keyPath of [
    'ACTIVATION_SIGNING_PRIVATE_KEY_PATH', 'ACTIVATION_SIGNING_PUBLIC_KEY_PATH',
    'PACKAGE_SIGNING_PRIVATE_KEY_PATH', 'PACKAGE_SIGNING_PUBLIC_KEY_PATH',
    'NOTIFICATION_SIGNING_PRIVATE_KEY_PATH', 'NOTIFICATION_SIGNING_PUBLIC_KEY_PATH',
  ]) {
    requireCondition(dockerEnv.includes(`${keyPath}=`), `.env.docker.example 缺少 ${keyPath}`);
    requireCondition(read('.env.example').includes(`${keyPath}=`), `.env.example 缺少 ${keyPath}`);
  }

  const installer = read('scripts/install-linux.sh');
  requireCondition(installer.includes(`NODE_IMAGE=\${APPGOG_NODE_IMAGE:-${contract.node_image}}`), 'Linux 安装器 Node 镜像不匹配');
  requireCondition(installer.includes(`CADDY_IMAGE=\${APPGOG_CADDY_IMAGE:-${contract.caddy_image}}`), 'Linux 安装器 Caddy 镜像不匹配');
  const composeMinor = Number(contract.docker_compose_min.split('.')[1]);
  const dockerInstallLibrary = read('scripts/lib/docker-install.sh');
  requireCondition(dockerInstallLibrary.includes('[ "$compose_minor" -ge "$required_minor" ]'), 'Docker 公共库缺少最低 Compose 版本判断');
  requireCondition(installer.includes(`appgog_compose_version_supported ${composeMinor}`), 'Linux 安装器最低 Compose 版本不匹配');
  requireCondition(read('scripts/docker.sh').includes(`appgog_compose_version_supported ${composeMinor}`), 'Docker 管理脚本最低 Compose 版本不匹配');
  for (const library of ['common', 'platform', 'docker-install', 'release-download', 'dns', 'backup', 'diagnostics', 'lifecycle']) {
    requireCondition(existsSync(join(root, `scripts/lib/${library}.sh`)), `缺少运维模块 scripts/lib/${library}.sh`);
  }
  const migrationScript = read('scripts/migration.sh');
  requireCondition(migrationScript.includes('source-fenced.json'), '缺少控制中心迁移 Fenced 执行器');
  requireCondition(migrationScript.includes('split -b 64m'), '控制中心迁移没有使用 64 MiB 分块');
  requireCondition(migrationScript.includes('/bundle/chunks/'), '控制中心迁移没有使用分块上传接口');
  requireCondition(migrationScript.includes('/bundle/complete'), '控制中心迁移没有执行整包最终校验');

  const migrationRoutes = read('apps/license-api/src/modules/migration/http-routes.js');
  requireCondition(migrationRoutes.includes('/bundle\\/chunks\\/(\\d+)'), '缺少控制中心迁移分块路由');
  requireCondition(migrationRoutes.includes('/bundle\\/complete'), '缺少控制中心迁移完成路由');
  requireCondition(existsSync(join(root, 'apps/web/public/assets/portal/migrations.js')), '缺少系统迁移管理界面模块');
  const schema = read('apps/license-api/src/schema.js');
  requireCondition(schema.includes('CREATE TABLE IF NOT EXISTS control_plane_identity'), '缺少 control_plane_identity 数据表');
  requireCondition(schema.includes('CREATE TABLE IF NOT EXISTS control_migrations'), '缺少 control_migrations 数据表');
  const initializer = read('scripts/docker/initialize.js');
  requireCondition(initializer.includes('source-fenced.json'), 'Docker 初始化缺少 Fenced 防双写检查');

  const publicKeyRoute = read('apps/license-api/src/http.js');
  requireCondition(publicKeyRoute.includes('public_keys: resolvedKeys'), '公钥接口没有返回三类签名公钥');

  const workflow = read('.github/workflows/docker.yml');
  requireCondition(Number(capture(workflow, /node-version:\s*['"]?([0-9]+)/, 'GitHub Actions node-version')) === contract.node_major, 'GitHub Actions Node 主版本不匹配');
  requireCondition(workflow.includes('node scripts/verify-release-contract.js --source'), 'GitHub Actions 缺少源文件发布合同检查');
  requireCondition(workflow.includes('node scripts/verify-release-contract.js --artifacts'), 'GitHub Actions 缺少安装包发布合同检查');
  requireCondition(workflow.includes("APPGOG_ALLOW_UNSIGNED_ARTIFACTS: '1'"), 'GitHub Actions 未明确标记非正式无签名制品');

  requireCondition(read('README.md').startsWith(`# APPGOG打包授权系统 v${version}\n`), 'README 标题版本不匹配');
  requireCondition(read('docs/architecture.md').startsWith(`# APPGOG打包授权系统架构（v${version}）\n`), '架构文档版本不匹配');
  requireCondition(read('docs/deployment.md').includes(`APPGOG打包授权系统 v${version} 的正式生产路线`), '部署文档版本不匹配');
  const notesPath = `docs/release-notes-v${version}.md`;
  requireCondition(existsSync(join(root, notesPath)), `缺少 ${notesPath}`);
  requireCondition(read(notesPath).startsWith(`# APPGOG打包授权系统 v${version}\n`), 'Release Notes 标题版本不匹配');
  requireCondition(read('AGENTS.md').includes('环境与安装包必须作为一个版本更新'), 'AGENTS.md 缺少强制发布规则');
  requireCondition(read('docs/release-policy.md').includes('APPGOG 强制升级与发布标准'), '缺少正式发布标准文档');
  requireCondition(read('docs/refactor-blueprint.md').includes('APPGOG 公司级重构蓝图'), '缺少公司级重构边界文档');
  requireCondition(read('docs/server-migration-standard.md').includes('APPGOG 服务器迁移标准'), '缺少服务器迁移标准文档');

  console.log(`发布合同源文件校验通过：APPGOG v${version} / Node ${contract.node_major} / ${contract.node_image} / ${contract.caddy_image}`);
  return { packageManifest, contract, version };
}

export function verifyPackagedArtifacts({ allowUnsigned = false } = {}) {
  const { packageManifest, contract, version } = verifySourceContract();
  const dist = join(root, 'dist');
  const releaseName = `APPGOG-Packaging-Licensing-System-${version}`;
  const zipPath = join(dist, `${releaseName}.zip`);
  const runPath = join(dist, `${releaseName}.run`);
  const manifestPath = join(dist, 'release-manifest.json');
  const signaturePath = `${manifestPath}.sig`;
  for (const path of [zipPath, `${zipPath}.sha256`, runPath, `${runPath}.sha256`, join(dist, 'install.sh'), manifestPath]) {
    requireCondition(existsSync(path), `缺少发布附件 ${basename(path)}`);
  }
  requireCondition(allowUnsigned || existsSync(signaturePath), '缺少正式发布清单签名 release-manifest.json.sig');

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
  if (existsSync(signaturePath)) {
    requireCondition(verify(null, readFileSync(manifestPath), read('scripts/release-public.pem'), readFileSync(signaturePath)),
      'release-manifest.json.sig Ed25519 验签失败');
  }
  const runContents = readFileSync(runPath, 'utf8');
  if (!allowUnsigned) {
    requireCondition(runContents.includes('openssl pkeyutl -verify'), '正式 RUN 缺少内嵌 Ed25519 验签步骤');
    requireCondition(runContents.includes(Buffer.from(read('scripts/release-public.pem')).toString('base64')),
      '正式 RUN 内嵌发布公钥不匹配');
  }

  const files = readZip(readFileSync(zipPath), { maxEntries: 1000, maxSingleFileBytes: 32 * 1024 * 1024, maxUncompressedBytes: 256 * 1024 * 1024 });
  const packaged = (path) => files.get(`${releaseName}/${path}`);
  for (const path of ['AGENTS.md', 'release-contract.json', 'docs/release-policy.md', 'docs/refactor-blueprint.md', 'docs/server-migration-standard.md', 'package.json', 'Dockerfile', 'compose.yaml', 'scripts/install-linux.sh']) {
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
  else if (mode === '--artifacts') verifyPackagedArtifacts({ allowUnsigned: process.env.APPGOG_ALLOW_UNSIGNED_ARTIFACTS === '1' });
  else throw new Error('用法：node scripts/verify-release-contract.js --source|--artifacts');
}

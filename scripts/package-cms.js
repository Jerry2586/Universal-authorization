import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { writeZip } from '../packages/core/src/zip.js';
import { createInstaller } from './package-installer.js';
import { verifyPackagedArtifacts, verifySourceContract } from './verify-release-contract.js';

const root = resolve(process.cwd());
const { contract: releaseContract } = verifySourceContract();
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const outputDirectory = join(root, 'dist');
const releaseName = `APPGOG-Packaging-Licensing-System-${manifest.version}`;
const output = join(outputDirectory, `${releaseName}.zip`);
const checksumOutput = `${output}.sha256`;
const files = new Map();
const rootFiles = ['.env.example', '.env.docker.example', '.gitignore', '.dockerignore', 'AGENTS.md', 'Caddyfile', 'compose.yaml', 'Dockerfile', 'package.json', 'pnpm-lock.yaml', 'README.md', 'release-contract.json', 'install-docker.sh'];
const sourceDirectories = ['apps', 'packages', 'scripts', 'docs'];

function addFile(path) {
  const name = relative(root, path).split(sep).join('/');
  const contents = readFileSync(path);
  files.set(`${releaseName}/${name}`, name.endsWith('.sh') ? Buffer.from(contents.toString('utf8').replaceAll('\r\n', '\n')) : contents);
}

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile()) addFile(path);
  }
}

for (const name of rootFiles) {
  const path = join(root, name);
  if (statSync(path).isFile()) addFile(path);
}
for (const name of sourceDirectories) walk(join(root, name));

mkdirSync(outputDirectory, { recursive: true });
const archive = writeZip(files, { date: new Date() });
const sha256 = createHash('sha256').update(archive).digest('hex');
const signingKeyPath = process.env.APPGOG_RELEASE_SIGNING_PRIVATE_KEY_PATH;
const privateKey = signingKeyPath ? createPrivateKey(readFileSync(resolve(signingKeyPath))) : null;
const publicKeyPem = readFileSync(join(root, 'scripts/release-public.pem'), 'utf8');
if (privateKey) {
  const configuredPublicKey = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'pem' });
  const signingPublicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  if (!Buffer.from(configuredPublicKey).equals(Buffer.from(signingPublicKey))) {
    throw new Error('发布私钥与 scripts/release-public.pem 不匹配');
  }
}
const archiveSignature = privateKey ? sign(null, archive, privateKey) : null;
writeFileSync(output, archive, { mode: 0o600 });
writeFileSync(checksumOutput, `${sha256}  ${basename(output)}\n`, { mode: 0o600 });
console.log(`v${manifest.version} 安装包已生成：${output}`);
console.log(`文件数量：${files.size}`);
console.log(`安装包名称：${basename(output)}`);
console.log(`SHA-256：${sha256}`);
console.log(`校验文件：${checksumOutput}`);

const installerPath = join(outputDirectory, releaseName + '.run');
const installer = createInstaller(archive, releaseName, { signature: archiveSignature, publicKey: publicKeyPem });
writeFileSync(installerPath, installer, { mode: 0o700 });
writeFileSync(installerPath + '.sha256', createHash('sha256').update(installer).digest('hex') + '  ' + basename(installerPath) + '\n', { mode: 0o600 });
console.log('一体安装文件：' + installerPath);

const installerSha256 = createHash('sha256').update(installer).digest('hex');
const manifestPath = join(outputDirectory, 'release-manifest.json');
const signaturePath = manifestPath + '.sig';
const bootstrapPath = join(outputDirectory, 'install.sh');
rmSync(signaturePath, { force: true });
const manifestBody = Buffer.from(JSON.stringify({
  schema: 2,
  product: 'appgog',
  version: manifest.version,
  zip_name: basename(output),
  zip_sha256: sha256,
  run_name: basename(installerPath),
  run_sha256: installerSha256,
  environment: releaseContract,
}, null, 2) + '\n');
writeFileSync(manifestPath, manifestBody, { mode: 0o600 });
writeFileSync(bootstrapPath, readFileSync(join(root, 'install-docker.sh'), 'utf8').replaceAll('\r\n', '\n'), { mode: 0o700 });
console.log(`稳定一键安装入口：${bootstrapPath}`);
if (signingKeyPath) {
  const signature = sign(null, manifestBody, privateKey);
  writeFileSync(signaturePath, signature, { mode: 0o600 });
  console.log(`签名发布清单：${manifestPath}`);
} else {
  console.warn('未设置 APPGOG_RELEASE_SIGNING_PRIVATE_KEY_PATH；已生成清单，但未生成数字签名。');
}
verifyPackagedArtifacts({ allowUnsigned: !privateKey && process.env.APPGOG_ALLOW_UNSIGNED_ARTIFACTS === '1' });

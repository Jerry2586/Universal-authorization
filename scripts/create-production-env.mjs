import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

const projectDirectory = process.cwd();
const templatePath = resolve(projectDirectory, '.env.example');
const outputPath = resolve(projectDirectory, process.argv[2] ?? '.env');

function parseEnvironment(content) {
  const values = new Map();

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const separator = rawLine.indexOf('=');
    if (separator <= 0) continue;

    values.set(rawLine.slice(0, separator).trim(), rawLine.slice(separator + 1).trim());
  }

  return values;
}

function randomSecret(bytes = 48) {
  return randomBytes(bytes).toString('base64url');
}

function isUnsafeSecret(value, placeholderPrefix) {
  return value === undefined
    || value.length < 32
    || value.toLowerCase().startsWith(placeholderPrefix);
}

function createSigningPrivateKey() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return Buffer.from(pem, 'utf8').toString('base64');
}

const template = await readFile(templatePath, 'utf8');
const outputAlreadyExists = existsSync(outputPath);
const existingContent = outputAlreadyExists ? await readFile(outputPath, 'utf8') : '';
const existing = parseEnvironment(existingContent);
const generated = new Map(existing);

const databaseName = existing.get('POSTGRES_DB') || 'license_server';
const databaseUser = existing.get('POSTGRES_USER') || 'license';
const databasePassword = existing.get('POSTGRES_PASSWORD') || randomBytes(24).toString('hex');

generated.set('NODE_ENV', 'production');
generated.set('HOST', '0.0.0.0');
generated.set('POSTGRES_DB', databaseName);
generated.set('POSTGRES_USER', databaseUser);
generated.set('POSTGRES_PASSWORD', databasePassword);

if (!existing.get('DATABASE_URL')) {
  generated.set(
    'DATABASE_URL',
    `postgresql://${encodeURIComponent(databaseUser)}:${encodeURIComponent(databasePassword)}@127.0.0.1:5432/${encodeURIComponent(databaseName)}`,
  );
}

if (!existing.get('MANAGEMENT_GATEWAY_TOKEN')) {
  generated.set('MANAGEMENT_GATEWAY_TOKEN', randomSecret());
}

if (!existing.get('LICENSE_KEY_PEPPER')) {
  generated.set('LICENSE_KEY_PEPPER', randomSecret());
}

if (!existing.get('LICENSE_SIGNING_PRIVATE_KEY_PEM_BASE64')) {
  generated.set('LICENSE_SIGNING_PRIVATE_KEY_PEM_BASE64', createSigningPrivateKey());
}

const templateKeys = new Set();
const outputLines = template.split(/\r?\n/u).map((line) => {
  const separator = line.indexOf('=');
  if (separator <= 0 || line.trimStart().startsWith('#')) return line;

  const key = line.slice(0, separator).trim();
  templateKeys.add(key);
  return `${key}=${generated.get(key) ?? line.slice(separator + 1)}`;
});

const extraEntries = [...generated.entries()]
  .filter(([key]) => !templateKeys.has(key))
  .map(([key, value]) => `${key}=${value}`);

if (extraEntries.length > 0) {
  outputLines.push('', '# 用户自定义配置', ...extraEntries);
}

await writeFile(outputPath, `${outputLines.join('\n').replace(/\n+$/u, '')}\n`, {
  encoding: 'utf8',
  mode: 0o600,
});

console.log(`[一键部署] 环境配置已准备：${outputPath}`);
console.log('[一键部署] 安全令牌、Key Pepper、数据库密码和 Ed25519 私钥已自动生成或保留。');

if (outputAlreadyExists) {
  const warnings = [];
  if (isUnsafeSecret(generated.get('MANAGEMENT_GATEWAY_TOKEN'), 'replace-management-token')) {
    warnings.push('MANAGEMENT_GATEWAY_TOKEN 仍是空值、短值或示例占位符');
  }
  if (isUnsafeSecret(generated.get('LICENSE_KEY_PEPPER'), 'replace-license-key-pepper')) {
    warnings.push('LICENSE_KEY_PEPPER 仍是空值、短值或示例占位符');
  }
  if (generated.get('POSTGRES_PASSWORD') === 'license') {
    warnings.push('POSTGRES_PASSWORD 仍是默认密码 license');
  }
  if (generated.get('LICENSE_KEY_PEPPER') === generated.get('MANAGEMENT_GATEWAY_TOKEN')) {
    warnings.push('LICENSE_KEY_PEPPER 不能与 MANAGEMENT_GATEWAY_TOKEN 相同');
  }

  if (warnings.length > 0) {
    console.warn('[一键部署] 检测到已有 .env，为避免破坏旧授权数据，脚本没有强制更换已有敏感值：');
    for (const warning of warnings) console.warn(`  - ${warning}`);
    console.warn('[一键部署] 新部署请修改这些值；已有业务数据时，修改 Pepper 或签名私钥前必须先制定迁移方案。');
  }
}

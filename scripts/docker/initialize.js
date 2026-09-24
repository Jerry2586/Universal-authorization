import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomInt } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const secretNames = ['KEY_HASH_PEPPER', 'ADMIN_TOKEN', 'WORKER_TOKEN', 'SESSION_SECRET', 'DELIVERY_ENCRYPTION_KEY', 'LICENSE_ENCRYPTION_KEY', 'INTERNAL_SERVICE_TOKEN'];
const legacySecretNames = secretNames.filter(name => name !== 'LICENSE_ENCRYPTION_KEY');
function validSecret(value) {
  return typeof value === 'string' && value.length >= 32 && !/^(replace-with|development-)/.test(value);
}
function hasEncryptedLicenseKeys(databasePath) {
  if (!existsSync(databasePath)) return false;
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'licenses'").get()) return false;
    const columns = new Set(database.prepare('PRAGMA table_info(licenses)').all().map(column => column.name));
    if (!columns.has('key_encrypted')) return false;
    return Boolean(database.prepare("SELECT 1 FROM licenses WHERE key_encrypted IS NOT NULL AND trim(key_encrypted) <> '' LIMIT 1").get());
  } catch (error) {
    throw new Error(`无法确认历史完整 Key 的加密状态：${error.message}`);
  } finally {
    database?.close();
  }
}
function migrateLicenseEncryptionKey(identity, databasePath) {
  identity.secrets ??= {};
  if (validSecret(identity.secrets.LICENSE_ENCRYPTION_KEY)) return false;
  if (hasEncryptedLicenseKeys(databasePath)) {
    throw new Error('检测到已经加密保存的完整 Key，但原 LICENSE_ENCRYPTION_KEY 缺失或无效；禁止自动换钥，请恢复升级前备份中的原身份配置');
  }
  identity.secrets.LICENSE_ENCRYPTION_KEY = randomBytes(48).toString('base64url');
  identity.migrations ??= {};
  identity.migrations.licenseEncryptionKey = new Date().toISOString();
  return true;
}
export function origin(value, label) {
  const url = new URL(value.includes('://') ? value : `https://${value}`);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.hostname.includes('.') || url.hostname.endsWith('.example.com') || url.hostname === 'example.com' || url.hostname === 'your-domain.com' || url.hostname.endsWith('.your-domain.com')) {
    throw new Error(`${label} 必须填写实际 HTTPS 域名`);
  }
  if (url.pathname !== '/' && !(label === '打包中心' && url.pathname === '/build')) throw new Error(`${label} 不应包含路径`);
  return url.origin;
}
function atomic(path, value) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, value, { mode: 0o600 });
  renameSync(temporary, path);
}
function envFile(values) {
  return Object.entries(values).map(([key, value]) => {
    if (/[\r\n]/.test(String(value))) throw new Error(`配置 ${key} 不能包含换行`);
    return `${key}=${value}`;
  }).join('\n') + '\n';
}

export function initialize({ root = '/app', env = process.env } = {}) {
  const configRoot = join(root, 'runtime');
  for (const name of ['license', 'build', 'worker', 'caddy-data', 'caddy-config']) mkdirSync(join(configRoot, name), { recursive: true });
  for (const name of ['data', 'keys', 'artifacts', 'uploads', 'update-control']) mkdirSync(join(root, 'var', name), { recursive: true });
  const identityPath = join(configRoot, 'license', 'identity.json');
  const privatePath = join(root, 'var/keys/ed25519-private.pem');
  const publicPath = join(root, 'var/keys/ed25519-public.pem');
  const databasePath = join(root, 'var/data/appgog.sqlite');
  const authUrl = origin(env.AUTH_DOMAIN || env.PUBLIC_BASE_URL || '', '授权中心');
  const buildUrl = origin(env.BUILD_DOMAIN || env.BUILD_CENTER_PUBLIC_URL || '', '打包中心');
  if (authUrl === buildUrl) throw new Error('授权中心与打包中心需要两个不同域名');
  const existing = existsSync(identityPath);
  const legacy = !existing && [databasePath, privatePath, publicPath].some(existsSync);
  let identity;
  let migratedLicenseEncryptionKey = false;
  if (existing) {
    identity = JSON.parse(readFileSync(identityPath, 'utf8'));
    if (identity.format !== 1) throw new Error('不支持的部署数据版本，禁止覆盖');
    migratedLicenseEncryptionKey = migrateLicenseEncryptionKey(identity, databasePath);
  } else {
    if (legacy && (!legacySecretNames.every(name => env[name]) || !env.ADMIN_USERNAME || !env.ADMIN_PASSWORD || !existsSync(privatePath) || !existsSync(publicPath))) {
      throw new Error('发现旧数据：必须提供原 .env 和完整签名密钥；禁止生成新凭证覆盖旧授权');
    }
    identity = { format: 1, createdAt: new Date().toISOString(), secrets: {}, adminUsername: env.ADMIN_USERNAME || 'admin', adminPassword: env.ADMIN_PASSWORD || String(randomInt(100000, 1000000)) };
    for (const name of secretNames) identity.secrets[name] = env[name] || randomBytes(48).toString('base64url');
    if (legacy && !validSecret(identity.secrets.LICENSE_ENCRYPTION_KEY)) migratedLicenseEncryptionKey = migrateLicenseEncryptionKey(identity, databasePath);
  }
  for (const name of secretNames) {
    const value = identity.secrets?.[name];
    if (!validSecret(value)) throw new Error(`无效的生产凭证 ${name}`);
  }
  if (!identity.adminUsername || typeof identity.adminPassword !== 'string' || identity.adminPassword.length < 6) throw new Error('管理员初始配置无效');
  identity.options ??= {};
  for (const name of ['ACTIVATION_TOKEN_TTL_SECONDS', 'OFFLINE_GRACE_SECONDS', 'BUILD_TICKET_TTL_SECONDS', 'DOWNLOAD_TICKET_TTL_SECONDS', 'WEB_SESSION_TTL_SECONDS', 'MAX_SOURCE_UPLOAD_BYTES']) {
    if (env[name] !== undefined && env[name] !== '') {
      if (!/^[1-9][0-9]*$/.test(env[name]) || !Number.isSafeInteger(Number(env[name]))) throw new Error(name + ' 必须为正整数');
      identity.options[name] = env[name];
    }
  }
  envFile({ ...identity.secrets, ADMIN_USERNAME: identity.adminUsername, ADMIN_PASSWORD: identity.adminPassword });
  if (existing && (!existsSync(privatePath) || !existsSync(publicPath))) throw new Error('持久化签名密钥丢失，请恢复备份；禁止重新生成');
  if (!existing && !legacy) {
    const pair = generateKeyPairSync('ed25519');
    writeFileSync(privatePath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    writeFileSync(publicPath, pair.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644, flag: 'wx' });
  }
  const privateKey = createPrivateKey(readFileSync(privatePath));
  const publicKey = createPublicKey(readFileSync(publicPath));
  if (privateKey.asymmetricKeyType !== 'ed25519' || !createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).equals(publicKey.export({ format: 'der', type: 'spki' }))) throw new Error('签名密钥不匹配');
  const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  if (existing && identity.keyFingerprint !== fingerprint) throw new Error('签名密钥指纹变化，拒绝启动');
  identity.keyFingerprint = fingerprint;
  atomic(identityPath, JSON.stringify(identity, null, 2));
  if (migratedLicenseEncryptionKey) console.log('APPGOG 已为旧部署补齐独立的 LICENSE_ENCRYPTION_KEY；原身份、签名密钥和历史数据保持不变。');
  const shared = { NODE_ENV: 'production', PUBLIC_BASE_URL: authUrl };
  atomic(join(configRoot, 'license/runtime.env'), envFile({ ...shared, ...identity.options, ...identity.secrets,
    ADMIN_USERNAME: identity.adminUsername, ADMIN_PASSWORD: identity.adminPassword,
    APPGOG_ROLE: 'license-center', EMBEDDED_WORKER: 'false', PORT: 8787,
    BUILD_CENTER_PUBLIC_URL: `${buildUrl}/build`, DATABASE_PATH: '/app/var/data/appgog.sqlite',
    SIGNING_PRIVATE_KEY_PATH: '/app/var/keys/ed25519-private.pem', SIGNING_PUBLIC_KEY_PATH: '/app/var/keys/ed25519-public.pem',
    ARTIFACT_ROOT: '/app/var/artifacts', UPLOAD_ROOT: '/app/var/uploads', UPDATE_CONTROL_PATH: '/app/var/update-control',
  }));
  atomic(join(configRoot, 'build/runtime.env'), envFile({ NODE_ENV: 'production', BUILD_CENTER_PORT: 8788,
    INTERNAL_LICENSE_URL: 'http://127.0.0.1:8787', INTERNAL_SERVICE_TOKEN: identity.secrets.INTERNAL_SERVICE_TOKEN }));
  atomic(join(configRoot, 'worker/runtime.env'), envFile({ ...shared, INTERNAL_LICENSE_URL: 'http://127.0.0.1:8787',
    WORKER_TOKEN: identity.secrets.WORKER_TOKEN, WORKER_REMOTE_TRANSFER: 'false', WORKER_ID: 'worker-compose-1', ARTIFACT_ROOT: '/app/var/artifacts' }));
  const credentialsPath = join(configRoot, 'license/initial-admin.txt');
  if (!existsSync(credentialsPath)) atomic(credentialsPath, `管理员账号：${identity.adminUsername}\n初始密码：${identity.adminPassword}\n后台修改过密码后，以后台的新密码为准。此文件仅记录初始凭证。\n`);
  console.log(existing ? 'APPGOG 初始化检查完成，保留现有密钥与数据。' : legacy ? 'APPGOG 旧部署凭证已导入，密钥保持不变。' : 'APPGOG 首次初始化完成，数据库将在授权服务首次启动时创建。');
  return { authUrl, buildUrl, identity };
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try { initialize(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

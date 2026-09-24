import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const roles = new Set(['all-in-one', 'license-center', 'build-center', 'worker']);
const args = process.argv.slice(2);

function option(name, fallback = '') {
  const prefix = `--${name}=`;
  const inline = args.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

function secret(bytes = 48) { return randomBytes(bytes).toString('base64url'); }
function line(key, value) { return `${key}=${String(value).replaceAll('\r', '').replaceAll('\n', '')}`; }

if (args.includes('--help')) {
  console.log(`APPGOG打包授权系统 安装配置器

用法：
  npm run cms:install -- --role all-in-one
  npm run cms:install -- --role license-center --public-url https://auth.example.com
  npm run cms:install -- --role build-center --license-url https://auth.example.com --node-token BLD_xxx
  npm run cms:install -- --role worker --license-url https://auth.example.com --node-token WRK_xxx

参数：
  --role            all-in-one | license-center | build-center | worker
  --output          环境文件路径，默认 .env
  --public-url      本服务公开地址
  --license-url     授权中心地址（独立打包中心和 Worker 必填）
  --node-token      在授权中心“系统与节点”创建的节点凭证
  --admin-user      首个管理员账号，默认 admin
  --admin-password  首个管理员密码；留空时自动生成
  --force           覆盖已有环境文件`);
  process.exit(0);
}

const role = option('role', 'all-in-one');
if (!roles.has(role)) throw new Error('安装角色无效：必须是 all-in-one、license-center、build-center 或 worker');
const output = resolve(process.cwd(), option('output', '.env'));
if (existsSync(output) && !args.includes('--force')) throw new Error(`${output} 已存在。为避免覆盖正式配置，请先备份，或明确加 --force。`);

const publicUrl = option('public-url', role === 'build-center' ? 'http://127.0.0.1:8788' : 'http://127.0.0.1:8787').replace(/\/+$/, '');
const licenseUrl = option('license-url', '');
const nodeToken = option('node-token', '');
const values = [line('NODE_ENV', 'production'), line('APPGOG_ROLE', role)];
let generatedPassword = '';

if (role === 'all-in-one' || role === 'license-center') {
  generatedPassword = option('admin-password') || `Appgog-${secret(24)}`;
  values.push(
    line('PORT', option('port', '8787')),
    line('DATABASE_PATH', './var/data/appgog.sqlite'),
    line('ACTIVATION_SIGNING_PRIVATE_KEY_PATH', './var/keys/ed25519-private.pem'),
    line('ACTIVATION_SIGNING_PUBLIC_KEY_PATH', './var/keys/ed25519-public.pem'),
    line('PACKAGE_SIGNING_PRIVATE_KEY_PATH', './var/keys/package-ed25519-private.pem'),
    line('PACKAGE_SIGNING_PUBLIC_KEY_PATH', './var/keys/package-ed25519-public.pem'),
    line('NOTIFICATION_SIGNING_PRIVATE_KEY_PATH', './var/keys/notification-ed25519-private.pem'),
    line('NOTIFICATION_SIGNING_PUBLIC_KEY_PATH', './var/keys/notification-ed25519-public.pem'),
    line('KEY_HASH_PEPPER', secret()),
    line('ADMIN_TOKEN', secret()),
    line('ADMIN_USERNAME', option('admin-user', 'admin')),
    line('ADMIN_PASSWORD', generatedPassword),
    line('WORKER_TOKEN', secret()),
    line('SESSION_SECRET', secret()),
    line('DELIVERY_ENCRYPTION_KEY', secret()),
    line('INTERNAL_SERVICE_TOKEN', secret()),
    line('PUBLIC_BASE_URL', publicUrl),
    line('BUILD_CENTER_PUBLIC_URL', option('build-url', role === 'all-in-one' ? `${publicUrl}/build` : 'https://build.example.com/build')),
    line('ARTIFACT_ROOT', './var/artifacts'),
    line('UPLOAD_ROOT', './var/uploads'),
    line('ACTIVATION_TOKEN_TTL_SECONDS', '604800'),
    line('OFFLINE_GRACE_SECONDS', '2592000'),
    line('BUILD_TICKET_TTL_SECONDS', '900'),
    line('DOWNLOAD_TICKET_TTL_SECONDS', '300'),
    line('WEB_SESSION_TTL_SECONDS', '28800'),
    line('MAX_SOURCE_UPLOAD_BYTES', '134217728'),
    line('EMBEDDED_WORKER', role === 'all-in-one' ? 'true' : 'false'),
  );
} else {
  if (!licenseUrl) throw new Error(`${role} 安装必须提供 --license-url`);
  if (nodeToken.length < 32) throw new Error(`${role} 安装必须提供授权中心创建的 --node-token`);
  values.push(line('INTERNAL_LICENSE_URL', licenseUrl.replace(/\/+$/, '')));
  if (role === 'build-center') {
    values.push(line('BUILD_CENTER_PORT', option('port', '8788')), line('BUILD_CENTER_NODE_TOKEN', nodeToken));
  } else {
    values.push(
      line('WORKER_NODE_TOKEN', nodeToken),
      line('WORKER_REMOTE_TRANSFER', 'true'),
      line('WORKER_ID', option('worker-id', `worker-${secret(8)}`)),
      line('PUBLIC_BASE_URL', licenseUrl.replace(/\/+$/, '')),
      line('ARTIFACT_ROOT', './var/worker-artifacts'),
    );
  }
}

writeFileSync(output, `${values.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
console.log(`APPGOG打包授权系统配置已写入：${output}`);
console.log(`安装角色：${role}`);
if (generatedPassword) {
  console.log(`管理员账号：${option('admin-user', 'admin')}`);
  console.log(`管理员密码：${generatedPassword}`);
  console.log('请立即保存密码；数据库初始化后，修改 .env 不会自动重置管理员密码。');
}
console.log('启动命令：npm run cms:start');

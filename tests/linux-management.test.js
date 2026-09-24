import assert from 'node:assert/strict';
import { accessSync, constants, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const scripts = {
  bootstrap: join(root, 'install-docker.sh'),
  docker: join(root, 'scripts/docker.sh'),
  installer: join(root, 'scripts/install-linux.sh'),
  manager: join(root, 'scripts/appgog.sh'),
  updateHelper: join(root, 'scripts/update-helper.sh'),
};

function text(path) {
  const contents = readFileSync(path, 'utf8');
  assert.ok(!contents.includes('\r\n'), `${path} 必须保持 LF 行尾`);
  return contents;
}

test('Linux installer installs Docker, protects existing configuration, and creates the global manager', () => {
  const installer = text(scripts.installer);
  assert.match(installer, /docker-ce docker-ce-cli containerd\.io docker-buildx-plugin docker-compose-plugin/);
  assert.match(installer, /minor.*-ge 24/);
  assert.match(installer, /x86_64\|amd64\|aarch64\|arm64/);
  assert.match(installer, /docker buildx version/);
  assert.match(installer, /4194304/);
  assert.match(installer, /add-port=443\/udp/);
  assert.match(installer, /verify_download/);
  assert.match(installer, /--source MODE/);
  assert.match(installer, /release-manifest\.json\.sig/);
  assert.match(installer, /openssl pkeyutl -verify/);
  assert.match(installer, /cloudflare_upsert_record/);
  assert.match(installer, /APPGOG_DOCKER_REGISTRY_MIRROR/);
  assert.match(installer, /select_base_images/);
  assert.match(installer, /m\.daocloud\.io\/docker\.io\/library\/node:24-bookworm-slim/);
  assert.match(installer, /docker\.m\.daocloud\.io\/library\/caddy:2\.10/);
  assert.match(installer, /手工指定的基础镜像不可用，未自动覆盖/);
  assert.match(installer, /--node-image[\s\S]*NODE_IMAGE_EXPLICIT=true/);
  assert.match(installer, /--caddy-image[\s\S]*CADDY_IMAGE_EXPLICIT=true/);
  assert.match(installer, /valid_image_ref/);
  assert.match(installer, /APPGOG_NODE_IMAGE=.*NODE_IMAGE/);
  assert.match(installer, /APPGOG_CADDY_IMAGE=.*CADDY_IMAGE/);
  assert.doesNotMatch(installer, /insecure-registries/);
  assert.match(installer, /sh scripts\/docker\.sh update/);
  assert.match(installer, /git clone.*\$temp_dir\/repository/);
  assert.match(installer, /copy_release_root "\$temp_dir\/repository"/);
  assert.match(installer, /\/opt\/appgog/);
  assert.match(installer, /保留已有 \.env/);
  assert.match(installer, /APPGOG_VERSION=.*package_version/);
  assert.match(installer, /chmod 600 "\$SHARED_DIR\/\.env"/);
  assert.match(installer, /RELEASES_DIR=.*releases/);
  assert.match(installer, /CURRENT_LINK=.*current/);
  assert.match(installer, /stage_release/);
  assert.match(installer, /mv -Tf .*CURRENT_LINK/);
  assert.match(installer, /appgog-update-helper\.service/);
  assert.match(installer, /case "\$existing" in[\s\S]*"\$INSTALL_ROOT"\/\*/);
  assert.doesNotMatch(installer, /ProtectSystem=strict/);
  assert.match(installer, /\/usr\/local\/bin\/appgog/);
  assert.match(installer, /preflight_network/);
  assert.match(installer, /DNS A 记录/);
  assert.match(installer, /Caddy 自动申请并续期 HTTPS/);
  assert.match(installer, /wait_public_https/);
});

test('stable bootstrap downloads, verifies, installs, upgrades, and rejects downgrade', () => {
  const bootstrap = text(scripts.bootstrap);
  assert.match(bootstrap, /releases\/latest\/download/);
  assert.match(bootstrap, /release-manifest\.json\.sig/);
  assert.match(bootstrap, /openssl pkeyutl -verify/);
  assert.match(bootstrap, /run_name/);
  assert.match(bootstrap, /run_sha256/);
  assert.match(bootstrap, /sha256sum -c/);
  assert.match(bootstrap, /ghfast\.top/);
  assert.match(bootstrap, /gh-proxy\.com/);
  assert.match(bootstrap, /running_image_version/);
  assert.match(bootstrap, /docker cp .*\/app\/package\.json/);
  assert.match(bootstrap, /State\.Health\.Status/);
  assert.match(bootstrap, /源码与运行镜像一致/);
  assert.match(bootstrap, /自动修复并重新部署/);
  assert.match(bootstrap, /拒绝自动降级/);
  assert.match(bootstrap, /sh "\$WORK_DIR\/installer\.run" "\$@"/);
});

test('management menu exposes safe lifecycle, logs, configuration, backup, restore, and diagnostics', () => {
  const manager = text(scripts.manager);
  for (const command of ['install', 'status', 'start', 'stop', 'restart', 'logs', 'config', 'services', 'credentials', 'update', 'rollback', 'backup', 'restore', 'doctor', 'diagnostics', 'repair', 'repair-source', 'uninstall', 'cleanup']) {
    assert.ok(manager.includes(command), `管理脚本缺少 ${command}`);
  }
  assert.match(manager, /确认保存配置/);
  assert.match(manager, /backups\/env-/);
  assert.match(manager, /危险操作会再次要求确认/);
  assert.match(manager, /operations\.log/);
  assert.match(manager, /配置差异/);
  assert.match(manager, /最近备份/);
  assert.match(manager, /更新状态/);
  assert.match(manager, /Cloudflare API Token/);
  assert.match(manager, /LICENSE_SERVICE_ENABLED/);
  assert.match(manager, /卸载系统（保留数据）/);
  assert.match(manager, /run_signed_installer/);
  assert.match(manager, /rm -rf "\$INSTALL_ROOT\/releases"/);
});

test('online update helper only accepts signed check, install, and repair actions', () => {
  const helper = text(scripts.updateHelper);
  assert.match(helper, /check-update\)/);
  assert.match(helper, /install-version\)/);
  assert.match(helper, /repair-current\)/);
  assert.match(helper, /openssl pkeyutl -verify/);
  assert.match(helper, /install-docker\.sh/);
  assert.match(helper, /chmod 770 "\$CONTROL_DIR" "\$REQUEST_DIR"/);
  assert.match(helper, /exec "\$CURRENT_LINK\/scripts\/update-helper\.sh" --daemon/);
  assert.ok(!helper.includes('eval '));
});

test('Docker operations keep destructive volume removal out of the supported workflow', () => {
  const docker = text(scripts.docker);
  assert.match(docker, /install\|update\)/);
  assert.match(docker, /doctor\(\)/);
  assert.match(docker, /logs\(\)/);
  assert.match(docker, /appgog-platform:rollback/);
  assert.match(docker, /diagnostics\(\)/);
  assert.match(docker, /repair_permissions\(\)/);
  assert.match(docker, /prepare_update_control\(\)/);
  assert.match(docker, /build_with_retry\(\)/);
  assert.match(docker, /APPGOG_BUILD_ATTEMPTS/);
  assert.match(docker, /基础镜像仓库、DNS 或 TLS 网络不可用/);
  assert.match(docker, /mkdir -p \/app\/var\/update-control\/requests/);
  assert.match(docker, /chown -R 1000:1000[\s\S]*\/app\/var\/update-control/);
  assert.match(docker, /chmod 770 \/app\/var\/update-control \/app\/var\/update-control\/requests/);
  assert.match(docker, /docker image prune -f/);
  assert.match(docker, /compose stop appgog/);
  assert.match(docker, /aes-256-cbc/);
  assert.match(docker, /pbkdf2/);
  assert.match(docker, /\.backup-key/);
  assert.match(docker, /DNS A 记录可解析/);
  assert.match(docker, /TLS 证书到期/);
  assert.match(docker, /Ed25519 签名密钥完整/);
  assert.match(docker, /mktemp .*appgog-restore/);
  assert.match(docker, /备份解密失败/);
  assert.ok(!docker.includes('openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "$BACKUP_KEY_FILE" -in "$archive" \\\n          | compose'));
  assert.ok(!docker.includes('down -v'));
  assert.ok(!docker.includes('volume rm'));
});

test('management shell scripts pass POSIX syntax validation when sh is available', t => {
  if (process.platform === 'win32') {
    t.skip('Windows Node test environment does not guarantee a POSIX shell on PATH');
    return;
  }
  accessSync('/bin/sh', constants.X_OK);
  for (const script of Object.values(scripts)) {
    const result = spawnSync('/bin/sh', ['-n', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
});

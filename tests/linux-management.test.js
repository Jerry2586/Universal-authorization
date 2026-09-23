import assert from 'node:assert/strict';
import { accessSync, constants, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const scripts = {
  docker: join(root, 'scripts/docker.sh'),
  installer: join(root, 'scripts/install-linux.sh'),
  manager: join(root, 'scripts/appgog.sh'),
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
  assert.match(installer, /verify_download/);
  assert.match(installer, /\/opt\/appgog\/APPGOG-CMS/);
  assert.match(installer, /\[ ! -f "\$INSTALL_DIR\/\.env" \] \|\| fail/);
  assert.match(installer, /chmod 600 "\$INSTALL_DIR\/\.env"/);
  assert.match(installer, /\/usr\/local\/bin\/appgog/);
  assert.match(installer, /不会接管 80\/443/);
});

test('management menu exposes safe lifecycle, logs, configuration, backup, restore, and diagnostics', () => {
  const manager = text(scripts.manager);
  for (const command of ['install', 'status', 'start', 'stop', 'restart', 'logs', 'config', 'credentials', 'update', 'backup', 'restore', 'doctor']) {
    assert.ok(manager.includes(command), `管理脚本缺少 ${command}`);
  }
  assert.match(manager, /确认保存配置/);
  assert.match(manager, /backups\/env-/);
  assert.match(manager, /危险操作会再次要求确认/);
});

test('Docker operations keep destructive volume removal out of the supported workflow', () => {
  const docker = text(scripts.docker);
  assert.match(docker, /install\|start|install\)/);
  assert.match(docker, /doctor\(\)/);
  assert.match(docker, /logs\(\)/);
  assert.ok(!docker.includes('down -v'));
  assert.ok(!docker.includes('volume rm'));
});

test('management shell scripts pass POSIX syntax validation when sh is available', t => {
  if (process.platform === 'win32') {
    t.skip('Windows Node test environment does not guarantee a POSIX shell on PATH');
    return;
  }
  accessSync('/bin/sh', constants.X_OK);
  const result = spawnSync('/bin/sh', ['-n', scripts.docker, scripts.installer, scripts.manager], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

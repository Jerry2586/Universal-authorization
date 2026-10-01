import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const bootstrapUrl = 'https://raw.githubusercontent.com/Jerry2586/Universal-authorization/main/install-docker.sh';
const read = file => readFileSync(resolve(root, file), 'utf8');

for (const file of ['README.md', 'docs/deployment.md']) {
  test(file + ' publishes one reusable online command per deployment role', () => {
    const commands = [...read(file).matchAll(/^curl -fsSL (\S+) \| sh -s -- --role (all|license|build) --auth-domain (\S+) --build-domain (\S+)$/gm)];
    assert.equal(commands.length, 3, 'all, license and build must each have a one-line command');
    assert.deepEqual(new Set(commands.map(match => match[2])), new Set(['all', 'license', 'build']));
    for (const [, url, , authDomain, buildDomain] of commands) {
      assert.equal(url, bootstrapUrl);
      assert.ok(authDomain && buildDomain && authDomain !== buildDomain);
    }
    assert.doesNotMatch(read(file), /^sudo sh \.\/APPGOG-Packaging-Licensing-System-.*\.run --role /m);
  });
}

test('bootstrap checks installed version before dispatching the same roles to the installer', () => {
  const bootstrap = read('install-docker.sh');
  const installer = read('scripts/install-linux.sh');
  assert.match(bootstrap, /installed_package=.*current\/package\.json/);
  assert.match(bootstrap, /installed_version.*=.*TARGET_VERSION/);
  assert.match(bootstrap, /sh "\$WORK_DIR\/installer\.run" "\$@"/);
  assert.match(installer, /ROLE_EXPLICIT.*false.*DEPLOYMENT_ROLE.*saved_role/);
  assert.match(installer, /现有安装角色不同/);
});

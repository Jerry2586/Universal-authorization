import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

test('business ingress and operations remain independent of security deployment', () => {
  for (const file of ['Caddyfile', 'Caddyfile.build', 'Caddyfile.license', 'compose.yaml', 'compose.build.yaml', 'compose.license.yaml', 'scripts/appgog.sh', 'scripts/docker.sh', 'scripts/install-linux.sh', 'scripts/migration.sh', 'scripts/backup-integrity.py']) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const external of ['/etc/ironcurtain', '/opt/ironcurtain', 'appgog-ingress', 'shared-ingress.sh', 'APPGOG_SHARED_INGRESS_LOCK', '/opt/appgog/shared/ingress']) {
      assert.equal(text.includes(external), false, file + ' retains external security coupling: ' + external);
    }
  }
  assert.equal(existsSync(join(root, 'scripts/lib/shared-ingress.sh')), false);
  assert.match(readFileSync(join(root, 'Caddyfile'), 'utf8'), /reverse_proxy 127\.0\.0\.1:8787/);
  assert.match(readFileSync(join(root, 'Caddyfile'), 'utf8'), /reverse_proxy 127\.0\.0\.1:8788/);
});

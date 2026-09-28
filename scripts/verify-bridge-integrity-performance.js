import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { signCompactToken } from '../packages/core/src/signing.js';
import { packageContentClaims } from '../packages/core/src/package-content.js';

// Same file count and approximate bytes as the real customer fixture, without shipping customer source.
// This bounds the verifier cost, not network latency or the total page-load duration.
const root = mkdtempSync(join(tmpdir(), 'appgog-integrity-perf-'));
try {
  const source = join(root, 'source'), state = join(root, 'state');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const identity = { typ: 'package-manifest', iss: 'perf-fixture', product: 'fixture', build_id: 'perf-build', package_id: 'perf-package', domain: 'fixture.invalid', version: '1.0.0', content_signature_required: true };
  const manifest = { schema: 2, ...identity, verification_keys: { package: pem }, package_manifest_token: signCompactToken(identity, privateKey), protection: { bridge_package_path: 'APPGOG/appgog-license/appgog-license-bridge.zip' }, integrity: { files: [] } };
  let bytes = 0;
  function add(relative, content) {
    const buffer = Buffer.from(content); const path = join(source, relative);
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, buffer);
    manifest.integrity.files.push({ path: 'APPGOG/' + relative, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') });
    bytes += buffer.length;
  }
  for (let i = 0; i < 26; i++) add(`assets/js/module-${i}.js`, `/* ${i} */\n` + 'void 0;\n'.repeat(14000));
  for (let i = 0; i < 461; i++) add(`assets/icons/icon-${i}.svg`, '<svg>' + ' '.repeat(1900) + '</svg>');
  for (let i = 0; i < 8; i++) add(`assets/css/style-${i}.css`, '.fixture{display:block}\n'.repeat(1500));
  for (const entry of ['index.html', 'editor.html', 'dashboard.blade.php']) add(entry, '<html><body>fixture</body></html>');
  add('appgog-license/appgog-license-bridge.zip', Buffer.alloc(800000, 7));
  for (let i = 0; i < 13; i++) add(`assets/data/data-${i}.json`, JSON.stringify({ data: 'fixture'.repeat(100) }));
  manifest.content_signature = signCompactToken(packageContentClaims(manifest, identity.iss), privateKey);
  writeFileSync(join(source, 'appgog-license/build.json'), JSON.stringify(manifest));
  const published = join(state, 'public/theme/APPGOG');
  mkdirSync(dirname(published), { recursive: true }); cpSync(source, published, { recursive: true });
  const keyPath = join(root, 'public.pem'); writeFileSync(keyPath, pem);
  const result = spawnSync(process.env.APPGOG_TEST_PHP || 'php', [resolve('tests/fixtures/bridge-content-signature.php'), resolve('apps/build-worker/xboard-bridge/AppgogLicenseBridge/Host/Guard.php'), source, state, keyPath, 'benchmark'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stderr);
  const measured = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
  assert.equal(measured.content_valid, true); assert.equal(measured.enrolled, true);
  const maxMs = Math.max(...measured.dual_tree_ms);
  console.log(JSON.stringify({ platform: process.platform, files_per_tree: manifest.integrity.files.length + 1, bytes_per_tree: bytes, ...measured, budget_ms: 250 }, null, 2));
  if (process.platform === 'linux') assert.ok(maxMs <= 250, `Dual-tree integrity check exceeds 250ms budget: ${maxMs}ms`);
} finally { rmSync(root, { recursive: true, force: true }); }

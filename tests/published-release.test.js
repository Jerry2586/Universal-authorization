import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { writeZip } from '../packages/core/src/zip.js';
import { verifyPublishedRelease } from '../scripts/verify-published-release.js';

const root = resolve(import.meta.dirname, '..');
const repository = 'example/appgog';
const apiBase = 'https://api.example.test';

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function buildReleaseFixture() {
  const packageManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const releaseContract = JSON.parse(readFileSync(join(root, 'release-contract.json'), 'utf8'));
  const version = packageManifest.version;
  const tag = `v${version}`;
  const releaseName = `APPGOG-Packaging-Licensing-System-${version}`;
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const zipEntries = new Map();
  for (const path of [
    'AGENTS.md',
    'release-contract.json',
    'docs/release-policy.md',
    'docs/refactor-blueprint.md',
    'docs/server-migration-standard.md',
    'package.json',
    'pnpm-lock.yaml',
    'Dockerfile',
    'Caddyfile',
    'Caddyfile.license',
    'Caddyfile.build',
    'compose.yaml',
    'compose.license.yaml',
    'compose.build.yaml',
    'scripts/install-linux.sh',
    'scripts/backup-integrity.py', 'docs/local-backup-integrity.md',
    'packages/core/src/host-scan-contract.js', 'docs/local-scan-report-contract.md',
    'scripts/install-host-security.sh',
    'scripts/host-security-agent.py',
    'scripts/host-security-response.py',
    'scripts/host-security-repair.py', 'scripts/host-security-cloudflare.py', 'scripts/host-security-firewall.py',
    'scripts/verify-host-security-linux.sh',
    'scripts/verify-host-security-response-linux.py', 'scripts/verify-host-security-firewall-linux.py',
    'docs/local-security-response.md', 'docs/local-cloudflare-monitor.md', 'docs/local-host-network-monitor.md', 'docs/local-host-firewall-monitor.md', 'docs/local-host-login-monitor.md',
    'scripts/security-connect.sh',
    'scripts/security-doctor.sh', 'scripts/security-local.sh',
    'scripts/security-agent.js',
    'scripts/lib/deployment-role.sh',
  ]) zipEntries.set(`${releaseName}/${path}`, readFileSync(join(root, path)));
  const zip = writeZip(zipEntries, { date: new Date('2026-09-25T00:00:00Z') });
  const run = Buffer.from(`#!/bin/sh\nopenssl pkeyutl -verify\n# ${Buffer.from(publicKeyPem).toString('base64')}\n`);
  const manifest = Buffer.from(`${JSON.stringify({
    schema: 2,
    product: 'appgog',
    version,
    zip_name: `${releaseName}.zip`,
    zip_sha256: sha256(zip),
    run_name: `${releaseName}.run`,
    run_sha256: sha256(run),
    environment: releaseContract,
  }, null, 2)}\n`);
  const assets = new Map([
    [`${releaseName}.zip`, zip],
    [`${releaseName}.zip.sha256`, Buffer.from(`${sha256(zip)}  ${releaseName}.zip\n`)],
    [`${releaseName}.run`, run],
    [`${releaseName}.run.sha256`, Buffer.from(`${sha256(run)}  ${releaseName}.run\n`)],
    ['install.sh', Buffer.from(readFileSync(join(root, 'install-docker.sh'), 'utf8').replaceAll('\r\n', '\n'))],
    ['release-manifest.json', manifest],
    ['release-manifest.json.sig', sign(null, manifest, privateKey)],
  ]);
  return { assets, publicKeyPem, releaseName, tag };
}

function mockGitHub(fixture, {
  latestTag = fixture.tag,
  names = [...fixture.assets.keys()],
  maliciousUrl = false,
  redirect = false,
  onRequest = () => {},
} = {}) {
  const assetPrefix = `${apiBase}/repos/${repository}/releases/assets/`;
  const release = {
    id: 1701,
    tag_name: fixture.tag,
    draft: false,
    prerelease: false,
    assets: names.map((name, index) => ({
      id: index + 1,
      name,
      url: maliciousUrl && index === 0 ? 'https://other.example.test/asset/1' : `${assetPrefix}${index + 1}`,
      browser_download_url: `https://downloads.example.test/${encodeURIComponent(name)}`,
    })),
  };
  return async (url, options = {}) => {
    onRequest(url, options);
    if (url === `${apiBase}/repos/${repository}/releases/tags/${encodeURIComponent(fixture.tag)}`) {
      return Response.json(release);
    }
    if (url === `${apiBase}/repos/${repository}/releases/latest`) {
      return Response.json({ ...release, id: latestTag === fixture.tag ? release.id : 1700, tag_name: latestTag });
    }
    if (url.startsWith(assetPrefix)) {
      if (options.headers?.Authorization !== 'Bearer test-private-token'
        || options.headers?.Accept !== 'application/octet-stream') return new Response('forbidden', { status: 403 });
      const asset = release.assets.find((item) => item.url === url);
      if (!asset) return new Response('not found', { status: 404 });
      if (redirect) return new Response(null, { status: 302, headers: { Location: `https://cdn.example.test/${encodeURIComponent(asset.name)}` } });
      return new Response(fixture.assets.get(asset.name));
    }
    const prefix = 'https://cdn.example.test/';
    if (url.startsWith(prefix)) {
      if (options.headers?.Authorization) return new Response('token leaked', { status: 403 });
      const name = decodeURIComponent(url.slice(prefix.length));
      return new Response(fixture.assets.get(name));
    }
    // Private repositories return 404 for anonymous browser download URLs.
    if (url.startsWith('https://downloads.example.test/')) return new Response('missing', { status: 404 });
    return new Response('not found', { status: 404 });
  };
}
async function verifyFixture(fixture, options = {}) {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'appgog-published-test-'));
  try {
    return await verifyPublishedRelease({
      tag: fixture.tag,
      repository,
      apiBase,
      outputDirectory,
      publicKeyPem: fixture.publicKeyPem,
      fetchFn: mockGitHub(fixture, options),
      token: options.token ?? 'test-private-token',
    });
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
}

test('GitHub Release 七附件回下载、签名、哈希与 Latest 状态全部通过', async () => {
  const fixture = buildReleaseFixture();
  const result = await verifyFixture(fixture);
  assert.equal(result.release.tag_name, fixture.tag);
  assert.equal(result.manifest.version, fixture.tag.slice(1));
});

test('GitHub Release 缺少或多出附件时拒绝', async () => {
  const fixture = buildReleaseFixture();
  const missing = [...fixture.assets.keys()].slice(0, -1);
  await assert.rejects(verifyFixture(fixture, { names: missing }), /附件数量应为 7/);
  const extraName = 'unexpected.txt';
  fixture.assets.set(extraName, Buffer.from('unexpected'));
  await assert.rejects(verifyFixture(fixture), /附件数量应为 7/);
});

test('GitHub Release 不是 Latest 时拒绝', async () => {
  const fixture = buildReleaseFixture();
  await assert.rejects(verifyFixture(fixture, { latestTag: 'v0.0.1' }), /Latest Release.*不是/);
});

test('GitHub Release 发布清单签名被篡改时拒绝', async () => {
  const fixture = buildReleaseFixture();
  fixture.assets.set('release-manifest.json', Buffer.concat([
    fixture.assets.get('release-manifest.json'),
    Buffer.from(' '),
  ]));
  await assert.rejects(verifyFixture(fixture), /Ed25519 验签失败/);
});

test('GitHub Release ZIP 或 RUN 哈希被篡改时拒绝', async () => {
  const fixture = buildReleaseFixture();
  fixture.assets.set(`${fixture.releaseName}.zip`, Buffer.concat([
    fixture.assets.get(`${fixture.releaseName}.zip`),
    Buffer.from('tampered'),
  ]));
  await assert.rejects(verifyFixture(fixture), /ZIP SHA-256 与发布清单不匹配/);
});

test('私有 Release 认证 API 下载，跨域重定向不传令牌', async () => {
  const fixture = buildReleaseFixture();
  const requests = [];
  await verifyFixture(fixture, { redirect: true, onRequest: (url, options) => requests.push({ url, options }) });
  assert.equal(requests.filter(({ url }) => url.startsWith('https://cdn.example.test/')).length, 7);
  assert.ok(requests.filter(({ url }) => url.startsWith('https://cdn.example.test/'))
    .every(({ options }) => !options.headers.Authorization && options.redirect === 'manual'));
  assert.equal(requests.filter(({ url }) => url.startsWith('https://downloads.example.test/')).length, 0);
});

test('私有 Release 拒绝外部附件 API URL', async () => {
  const fixture = buildReleaseFixture();
  await assert.rejects(verifyFixture(fixture, { maliciousUrl: true }), /API 地址不属于当前仓库/);
});

test('没有令牌时私有 Release 下载明确失败', async () => {
  const fixture = buildReleaseFixture();
  await assert.rejects(verifyFixture(fixture, { token: '' }), /附件下载失败 404/);
});

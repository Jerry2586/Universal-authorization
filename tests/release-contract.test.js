import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { verifySourceContract } from '../scripts/verify-release-contract.js';

const root = resolve(import.meta.dirname, '..');

test('发布合同强制环境、版本、文档和CI保持一致', () => {
  const result = verifySourceContract();
  assert.match(result.version, /^\d+\.\d+\.\d+$/);
  assert.equal(result.packageManifest.engines.node, result.contract.node_engine);
  assert.equal(result.packageManifest.packageManager, result.contract.package_manager);
  assert.equal(result.contract.node_major, 24);
});

test('正式打包流程必须在生成前后执行发布合同校验', () => {
  const packager = readFileSync(resolve(root, 'scripts/package-cms.js'), 'utf8');
  assert.match(packager, /verifySourceContract\(\)/);
  assert.match(packager, /verifyPackagedArtifacts\(\{ allowUnsigned:/);
  const verifier = readFileSync(resolve(root, 'scripts/verify-release-contract.js'), 'utf8');
  assert.match(verifier, /release-manifest\.json\.sig/);
  assert.match(verifier, /Ed25519 验签失败/);
  assert.match(verifier, /正式 RUN 缺少内嵌 Ed25519 验签步骤/);
  assert.match(verifier, /APPGOG_ALLOW_UNSIGNED_ARTIFACTS === '1'/);
  const publishedVerifier = readFileSync(resolve(root, 'scripts/verify-published-release.js'), 'utf8');
  assert.match(publishedVerifier, /releases\/latest/);
  assert.match(publishedVerifier, /assets\.length === expectedNames\.length/);
  assert.match(publishedVerifier, /verifyPackagedArtifacts/);
  const policy = readFileSync(resolve(root, 'AGENTS.md'), 'utf8');
  assert.match(policy, /CI 成功后才能创建版本标签/);
  assert.match(policy, /数据库.*管理员账号和密码.*授权 Key.*公告.*设置/s);
  assert.match(policy, /index\.html.*editor\.html.*dashboard\.blade\.php/s);
  assert.match(policy, /禁止静默回退输出明文/);
});

test('main 更新必须自动生成签名 Latest Release 并持续检查漂移', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/docker.yml'), 'utf8');
  assert.match(workflow, /needs: verify/);
  assert.match(workflow, /APPGOG_RELEASE_SIGNING_PRIVATE_KEY/);
  assert.match(workflow, /npm run cms:package/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /gh release upload/);
  assert.match(workflow, /verify-published-release\.js --tag/);
  assert.doesNotMatch(workflow.match(/release:[\s\S]*$/)?.[0] ?? '', /APPGOG_ALLOW_UNSIGNED_ARTIFACTS/);
  const drift = readFileSync(resolve(root, '.github/workflows/release-drift.yml'), 'utf8');
  assert.match(drift, /schedule:/);
  assert.match(drift, /verify-published-release\.js --tag "v\$version"/);
});

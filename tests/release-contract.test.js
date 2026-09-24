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
  assert.equal(result.contract.node_major, 24);
});

test('正式打包流程必须在生成前后执行发布合同校验', () => {
  const packager = readFileSync(resolve(root, 'scripts/package-cms.js'), 'utf8');
  assert.match(packager, /verifySourceContract\(\)/);
  assert.match(packager, /verifyPackagedArtifacts\(\)/);
  const policy = readFileSync(resolve(root, 'AGENTS.md'), 'utf8');
  assert.match(policy, /CI 成功后才能创建版本标签/);
  assert.match(policy, /数据库.*管理员账号和密码.*授权 Key.*公告.*设置/s);
});

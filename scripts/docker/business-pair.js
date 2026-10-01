import { readFileSync } from 'node:fs';
import { openDatabase, transaction } from '../../apps/license-api/src/database.js';
import { createRepository } from '../../apps/license-api/src/repository.js';
import { createOperationsRepositoryPort } from '../../apps/license-api/src/modules/operations/repository-port.js';
import { createOperationsService } from '../../apps/license-api/src/modules/operations/service.js';
import { PACKAGE_VERSION } from '../../packages/core/src/version.js';

// Run only via the privileged Linux menu inside the authorization container.
const values = Object.fromEntries(readFileSync('/app/runtime/license/runtime.env', 'utf8').trimEnd().split('\n').map(line => {
  const split = line.indexOf('=');
  return [line.slice(0, split), line.slice(split + 1)];
}));
const [action, buildUrl, firstId, secondId] = process.argv.slice(2);
if (process.env.APPGOG_DEPLOYMENT_ROLE !== 'license' || !values.KEY_HASH_PEPPER) throw new Error('仅独立授权机可以签发分机节点凭据');
if (!['create', 'disable'].includes(action)) throw new Error('未知操作');
if (action === 'create' && buildUrl !== process.env.BUILD_DOMAIN) throw new Error('打包域名与本机配置不一致');
const database = openDatabase('/app/var/data/appgog.sqlite');
try {
  const service = createOperationsService({ repository: createOperationsRepositoryPort(createRepository(database)),
    config: { pepper: values.KEY_HASH_PEPPER }, packageVersion: PACKAGE_VERSION });
  const actor = 'linux-host-root';
  if (action === 'create') {
    const result = transaction(database, () => {
      const build = service.createServiceNode({ name: 'Linux 打包分机', role: 'build-center', public_url: 'https://' + buildUrl }, actor);
      const worker = service.createServiceNode({ name: 'Linux 构建 Worker', role: 'worker' }, actor);
      return { format: 1, auth_url: values.PUBLIC_BASE_URL, build_url: 'https://' + buildUrl,
        version: PACKAGE_VERSION, build_node_id: build.node.id, worker_node_id: worker.node.id,
        BUILD_CENTER_NODE_TOKEN: build.credential, WORKER_NODE_TOKEN: worker.credential };
    });
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
    if (!/^nod_[A-Za-z0-9_-]+$/.test(firstId ?? '') || !/^nod_[A-Za-z0-9_-]+$/.test(secondId ?? '') || firstId === secondId) throw new Error('节点 ID 无效');
    transaction(database, () => {
      service.changeServiceNodeStatus(firstId, 'disabled', actor);
      service.changeServiceNodeStatus(secondId, 'disabled', actor);
    });
    process.stdout.write('两个业务节点已撤销\n');
  }
} finally { database.close(); }

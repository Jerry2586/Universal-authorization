import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

test('packages and independent services do not import license-api application internals', () => {
  const sqliteQueue = read('packages/adapters/src/sqlite-build-queue.js');
  const worker = read('apps/build-worker/src/server.js');
  const buildCenter = read('apps/build-center/src/server.js');
  assert.doesNotMatch(sqliteQueue, /apps\/license-api/, '适配器不得反向依赖应用层数据库模块');
  assert.doesNotMatch(worker, /license-api\/src\/config/, '独立 Worker 不得依赖授权中心配置实现');
  assert.doesNotMatch(buildCenter, /license-api\/src\/config/, '独立打包中心不得依赖授权中心配置实现');
  assert.match(worker, /packages\/core\/src\/environment/);
  assert.match(buildCenter, /packages\/core\/src\/environment/);
});

test('control-plane migration owns its repository, service and HTTP route boundary', () => {
  const bootstrap = read('apps/license-api/src/bootstrap.js');
  const http = read('apps/license-api/src/http.js');
  const repository = read('apps/license-api/src/repository.js');
  for (const module of [
    './modules/migration/control.js',
    './modules/migration/repository.js',
    './modules/migration/http-routes.js',
  ]) assert.ok(bootstrap.includes(module) || http.includes(module), `缺少迁移模块边界 ${module}`);
  assert.doesNotMatch(repository, /createControlMigration|controlPlaneIdentity|control_migrations/,
    '全库 Repository 不得重新接管迁移领域');
  assert.doesNotMatch(http, /url\.pathname === '\/api\/v1\/control-migrations\/handshake'/,
    '迁移 HTTP 路由必须留在独立模块');
  const migrationRoutes = read('apps/license-api/src/modules/migration/http-routes.js');
  assert.doesNotMatch(migrationRoutes, /portal\.repository|\.audit\s*\(/,
    '迁移路由不得绕过应用服务直接访问 Repository 或写审计');
});

test('production server wires migration control and HTTP does not cross repository boundary', () => {
  const server = read('apps/license-api/src/server.js');
  const http = read('apps/license-api/src/http.js');
  assert.match(server, /\{[^}]*migrations[^}]*\}\s*=\s*bootstrap\(/s,
    '生产启动入口必须接收 bootstrap 返回的 migrations');
  assert.match(server, /createHttpHandler\(\{[^}]*migrations[^}]*\}\)/s,
    '生产启动入口必须向 HTTP Handler 注入 migrations');
  assert.doesNotMatch(http, /portal\.repository/,
    'HTTP 路由不得绕过应用服务直接访问 Portal Repository');
});

test('admin accounts and operations own explicit HTTP route modules', () => {
  const http = read('apps/license-api/src/http.js');
  const adminRoutes = read('apps/license-api/src/modules/admin/http-routes.js');
  const operationsRoutes = read('apps/license-api/src/modules/operations/http-routes.js');
  assert.match(http, /handleAdminAccountHttp/);
  assert.match(http, /handleOperationsHttp/);
  assert.match(adminRoutes, /\/web\/admin\/account\/password/);
  assert.match(operationsRoutes, /\/web\/admin\/system\/update/);
  assert.doesNotMatch(http, /url\.pathname === '\/web\/admin\/admins'/,
    '管理员账号路由不得重新堆回主 HTTP 入口');
  assert.doesNotMatch(http, /url\.pathname === '\/web\/admin\/system\/update'/,
    '运营更新路由不得重新堆回主 HTTP 入口');
  assert.doesNotMatch(`${adminRoutes}\n${operationsRoutes}`, /portal\.repository|\.audit\s*\(/,
    '领域路由不得直接访问 Repository 或写审计');
});

test('activation and packaging APIs own explicit route modules', () => {
  const http = read('apps/license-api/src/http.js');
  const activationRoutes = read('apps/license-api/src/modules/activation/http-routes.js');
  const packagingRoutes = read('apps/license-api/src/modules/packaging/http-routes.js');
  assert.match(http, /handleActivationHttp/);
  assert.match(http, /handlePackagingHttp/);
  assert.match(activationRoutes, /\/api\/v1\/installation-challenges/);
  assert.match(packagingRoutes, /\/api\/v1\/worker\/jobs/);
  assert.doesNotMatch(http, /url\.pathname === '\/api\/v1\/activations'/,
    '激活路由不得重新堆回主 HTTP 入口');
  assert.doesNotMatch(http, /url\.pathname === '\/api\/v1\/worker\/jobs\/lease'/,
    'Worker 路由不得重新堆回主 HTTP 入口');
  assert.doesNotMatch(`${activationRoutes}\n${packagingRoutes}`, /portal\.repository|\.audit\s*\(/,
    '领域路由不得直接访问 Repository 或写审计');
});

test('support owns its customer and admin HTTP routes', () => {
  const http = read('apps/license-api/src/http.js');
  const supportRoutes = read('apps/license-api/src/modules/support/http-routes.js');
  assert.match(http, /handleSupportHttp/);
  assert.ok(supportRoutes.includes('/web/customer/tickets') || supportRoutes.includes('\\/web\\/customer\\/tickets'));
  assert.ok(supportRoutes.includes('/web/admin/tickets') || supportRoutes.includes('\\/web\\/admin\\/tickets'));
  assert.doesNotMatch(http, /url\.pathname === '\/web\/customer\/tickets'/,
    '客户工单路由不得重新堆回主 HTTP 入口');
  assert.doesNotMatch(http, /url\.pathname\.match\(\/\^\\\/web\\\/admin\\\/tickets/,
    '管理工单路由不得重新堆回主 HTTP 入口');
  assert.doesNotMatch(supportRoutes, /portal\.repository|\.audit\s*\(/,
    'Support 路由不得直接访问 Repository 或写审计');
});

test('identity and operations services receive bounded repository ports', () => {
  const bootstrap = read('apps/license-api/src/bootstrap.js');
  const portal = read('apps/license-api/src/portal-service.js');
  const identityPort = read('apps/license-api/src/modules/identity/repository-port.js');
  const operationsPort = read('apps/license-api/src/modules/operations/repository-port.js');
  assert.match(bootstrap, /createIdentityRepositoryPort\(repository\)/);
  assert.match(bootstrap, /createOperationsRepositoryPort\(repository\)/);
  assert.doesNotMatch(portal, /createAdminAccount|changeAdminPassword|authenticateServiceNode|updateCmsSettings/,
    'Portal Service 不得重新接管 Identity 或 Operations 用例');
  assert.doesNotMatch(identityPort, /licenseById|createBuildJob|createSupportTicket/,
    'Identity Repository Port 不得暴露其他领域写接口');
  assert.doesNotMatch(operationsPort, /licenseById|createBuildJob|createSupportTicket/,
    'Operations Repository Port 不得暴露其他领域写接口');
});

test('session and licensing services cannot reach the full repository', () => {
  const bootstrap = read('apps/license-api/src/bootstrap.js');
  const sessionPort = read('apps/license-api/src/modules/identity/session-repository-port.js');
  const licensingPort = read('apps/license-api/src/modules/licensing/repository-port.js');
  assert.match(bootstrap, /createSessionRepositoryPort\(repository\)/);
  assert.match(bootstrap, /createLicensingRepositoryPort\(repository\)/);
  assert.doesNotMatch(sessionPort, /createBuild|createSupportTicket|setSetting/);
  assert.doesNotMatch(licensingPort, /createAdmin|createSupportTicket|setSetting|createServiceNode/);
});

test('support use cases own a bounded repository port and stay outside the portal facade', () => {
  const bootstrap = read('apps/license-api/src/bootstrap.js');
  const portal = read('apps/license-api/src/portal-service.js');
  const supportPort = read('apps/license-api/src/modules/support/repository-port.js');
  const supportService = read('apps/license-api/src/modules/support/service.js');
  assert.match(bootstrap, /createSupportRepositoryPort\(repository\)/);
  assert.match(bootstrap, /createSupportService\(/);
  assert.doesNotMatch(portal, /createCustomerTicket|updateAdminTicket|addSupportAttachment|createSupportTicket|listSupportTickets/,
    'Portal Service 不得重新接管 Support 用例或直接访问 Support Repository');
  assert.match(supportService, /createCustomerTicket/);
  assert.match(supportService, /updateAdminTicket/);
  assert.match(supportService, /addSupportAttachment/);
  assert.doesNotMatch(supportPort, /createAdmin|createLicense|setSetting|createBuildJob|createServiceNode/,
    'Support Repository Port 不得暴露身份、授权、构建或运营领域写接口');
});

test('packaging and product use cases own bounded services and repository ports', () => {
  const bootstrap = read('apps/license-api/src/bootstrap.js');
  const portal = read('apps/license-api/src/portal-service.js');
  const packagingPort = read('apps/license-api/src/modules/packaging/repository-port.js');
  const packagingService = read('apps/license-api/src/modules/packaging/service.js');
  const productPort = read('apps/license-api/src/modules/product/repository-port.js');
  const productService = read('apps/license-api/src/modules/product/service.js');
  assert.match(bootstrap, /createPackagingRepositoryPort\(repository\)/);
  assert.match(bootstrap, /createProductRepositoryPort\(repository\)/);
  assert.match(packagingService, /enqueueCustomerBuild/);
  assert.match(packagingService, /completeBuild/);
  assert.match(productService, /publishSourceVersion/);
  assert.match(productService, /withdrawSourceVersion/);
  assert.doesNotMatch(portal,
    /enqueueCustomerBuild|completeBuild|publishSourceVersion|withdrawSourceVersion|sourceMetadata/,
    'Portal Service 不得重新接管 Packaging 或 Product 用例');
  assert.doesNotMatch(packagingPort, /createAdmin|createSupportTicket|setSetting|createServiceNode|createSourceVersion/,
    'Packaging Repository Port 不得暴露身份、工单、运营或产品发布写接口');
  assert.doesNotMatch(productPort, /createAdmin|createSupportTicket|createBuildJob|setSetting|licenseById/,
    'Product Repository Port 不得暴露身份、工单、构建或授权接口');
});

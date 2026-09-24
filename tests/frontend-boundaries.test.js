import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { createPermissionCheck, createPortalState } from '../apps/web/public/assets/portal/core.js';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const lines = (path) => read(path).split('\n').length;

test('admin and customer portals use separate entrypoints, state and page controllers', () => {
  const adminHtml = read('apps/web/public/admin.html');
  const customerHtml = read('apps/web/public/build.html');
  const adminEntry = read('apps/web/public/assets/admin-portal.js');
  const customerEntry = read('apps/web/public/assets/customer-portal.js');
  const compatibilityEntry = read('apps/web/public/assets/portal.js');
  assert.match(adminHtml, /<script src="\/assets\/admin-portal\.js" type="module"><\/script>/);
  assert.match(customerHtml, /<script src="\/assets\/customer-portal\.js" type="module"><\/script>/);
  assert.match(adminEntry, /createPortalShell\('admin'\)/);
  assert.match(adminEntry, /createAdminPage/);
  assert.match(customerEntry, /createPortalShell\('customer'\)/);
  assert.match(customerEntry, /createCustomerPage/);
  assert.match(compatibilityEntry, /import\('\.\/admin-portal\.js'\)/);
  assert.match(compatibilityEntry, /import\('\.\/customer-portal\.js'\)/);
  assert.doesNotMatch(adminEntry, /customer-page/);
  assert.doesNotMatch(customerEntry, /admin-page/);

  const adminState = createPortalState('admin');
  const customerState = createPortalState('customer');
  adminState.permissions.push('*');
  assert.notStrictEqual(adminState, customerState);
  assert.equal(createPermissionCheck(adminState)('system.manage'), true);
  assert.equal(createPermissionCheck(customerState)('system.manage'), false);
});

test('shared portal shell owns transport, session and navigation without business-page imports', () => {
  const shell = read('apps/web/public/assets/portal/shell.js');
  for (const module of ['./core.js', './api-client.js', './dialog.js']) {
    assert.ok(shell.includes(`from '${module}'`), `共享 Shell 缺少 ${module}`);
  }
  assert.doesNotMatch(shell, /admin-page|customer-page|licenses\.js|tickets\.js|migrations\.js/);
  assert.doesNotMatch(shell, /\bfetch\s*\(|new XMLHttpRequest/);
  assert.match(shell, /\/web\/\$\{actor\}\/login/);
  assert.match(shell, /\/web\/session\?actor=\$\{actor\}/);
});

test('page controllers stay actor-bounded and all portal modules remain small', () => {
  const admin = read('apps/web/public/assets/portal/admin-page.js');
  const customer = read('apps/web/public/assets/portal/customer-page.js');
  assert.match(admin, /createLicenseUi/);
  assert.match(admin, /createMigrationUi/);
  assert.match(admin, /createOperationsUi/);
  assert.doesNotMatch(admin, /\/web\/customer\//);
  assert.match(customer, /renderCustomerTickets/);
  assert.doesNotMatch(customer, /renderAdminTickets|\/web\/admin\//);
  const modules = [
    'apps/web/public/assets/portal/core.js',
    'apps/web/public/assets/portal/api-client.js',
    'apps/web/public/assets/portal/ui.js',
    'apps/web/public/assets/portal/dialog.js',
    'apps/web/public/assets/portal/shell.js',
    'apps/web/public/assets/portal/customer-page.js',
    'apps/web/public/assets/portal/admin-page.js',
    'apps/web/public/assets/portal/admin-dashboard.js',
    'apps/web/public/assets/portal/admin-release-upload.js',
    'apps/web/public/assets/portal/tickets.js',
    'apps/web/public/assets/portal/migrations.js',
    'apps/web/public/assets/portal/announcements.js',
    'apps/web/public/assets/portal/members.js',
    'apps/web/public/assets/portal/operations.js',
  ];
  for (const module of modules) assert.ok(lines(module) <= 300, `${module} 超过 300 行，应继续按职责拆分`);
});

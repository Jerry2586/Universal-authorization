import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const lines = (path) => read(path).split('\n').length;

test('portal entrypoint delegates transport, shared UI, dialogs, and tickets to explicit modules', () => {
  const entry = read('apps/web/public/assets/portal.js');
  assert.ok(lines('apps/web/public/assets/portal.js') <= 700, 'portal.js 不得重新膨胀为多领域巨型入口');
  for (const module of [
    './portal/core.js', './portal/api-client.js', './portal/ui.js', './portal/dialog.js', './portal/tickets.js',
    './portal/migrations.js', './portal/announcements.js', './portal/members.js', './portal/operations.js',
  ]) {
    assert.ok(entry.includes(`from '${module}'`), `portal.js 缺少模块边界 ${module}`);
  }
  assert.doesNotMatch(entry, /\bfetch\s*\(/, '页面入口不得绕过统一 API Client 直接 fetch');
  assert.doesNotMatch(entry, /new XMLHttpRequest/, '页面入口不得自行实现上传传输');
  assert.doesNotMatch(entry, /function renderAdminTicketDetail|function renderCustomerTicketDetail/, '工单 UI 必须留在工单模块');
});

test('portal modules stay bounded and both pages load the ES module entrypoint', () => {
  const modules = [
    'apps/web/public/assets/portal/core.js',
    'apps/web/public/assets/portal/api-client.js',
    'apps/web/public/assets/portal/ui.js',
    'apps/web/public/assets/portal/dialog.js',
    'apps/web/public/assets/portal/tickets.js',
    'apps/web/public/assets/portal/migrations.js',
    'apps/web/public/assets/portal/announcements.js',
    'apps/web/public/assets/portal/members.js',
    'apps/web/public/assets/portal/operations.js',
  ];
  for (const module of modules) assert.ok(lines(module) <= 300, `${module} 超过 300 行，应继续按职责拆分`);
  for (const page of ['apps/web/public/admin.html', 'apps/web/public/build.html']) {
    assert.match(read(page), /<script src="\/assets\/portal\.js" type="module"><\/script>/);
  }
});

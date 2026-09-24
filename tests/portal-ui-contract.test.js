import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const read = (name) => readFileSync(resolve(root, name), 'utf8');

test('admin UI exposes independent announcement, protected key reveal, and signed online update controls', () => {
  const html = read('apps/web/public/admin.html');
  const script = read('apps/web/public/assets/portal.js');
  assert.match(html, /data-view="announcements"/);
  assert.match(html, /id="announcement-form"/);
  assert.match(html, /class="announcement-operations-grid"/);
  assert.match(html, /id="announcement-preview-card"/);
  assert.match(html, /id="announcement-title-count"/);
  assert.match(html, /id="admin-system-version"/);
  assert.match(html, /id="check-update"/);
  assert.match(html, /id="install-update"/);
  assert.match(html, /id="repair-current"/);
  assert.match(html, /安全更新最新版本/);
  assert.match(html, /data-view="tickets"/);
  assert.match(html, /id="admin-ticket-list"/);
  assert.match(html, /id="version-search"/);
  assert.match(html, /id="logout" class="header-logout"/);
  assert.doesNotMatch(html, /返回首页/);
  assert.doesNotMatch(html, /name="min_xboard_version"|name="min_upgrade_version"/);
  assert.doesNotMatch(html, /rollback_allowed|rollback_to|允许生成回滚包|推荐回滚版本/);
  assert.match(script, /重新验证密码后查看完整 Key/);
  assert.match(script, /\/web\/admin\/announcement/);
  assert.match(script, /renderAnnouncementPreview/);
  assert.match(script, /install-version/);
});

test('customer build UI keeps the version catalog in build tasks and removes migration notes', () => {
  const html = read('apps/web/public/build.html');
  const script = read('apps/web/public/assets/portal.js');
  const buildsPage = html.indexOf('data-page="builds"');
  const catalog = html.indexOf('id="version-catalog"');
  assert.ok(buildsPage >= 0 && catalog > buildsPage);
  assert.doesNotMatch(html, /name="reason"/);
  assert.doesNotMatch(html, /＋ 新建构建/);
  assert.match(html, /id="customer-system-version"/);
  assert.match(html, /id="announcement-toggle"/);
  assert.match(html, /class="surface delivery-flow-card"/);
  assert.match(html, />交付步骤</);
  assert.match(html, />安装并正式激活</);
  assert.match(html, /data-view="tickets"/);
  assert.match(html, /id="customer-ticket-form"/);
  assert.doesNotMatch(html, /生成回滚包|回滚构建/);
  assert.match(script, /renderCustomerTickets/);
  assert.match(script, /renderAdminTickets/);
});

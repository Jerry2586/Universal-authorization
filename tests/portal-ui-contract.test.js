import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const read = (name) => readFileSync(resolve(root, name), 'utf8');

test('admin UI exposes independent announcement, protected key reveal, and signed online update controls', () => {
  const html = read('apps/web/public/admin.html');
  const script = read('apps/web/public/assets/portal/admin-page.js');
  const licenses = read('apps/web/public/assets/portal/licenses.js');
  const announcements = read('apps/web/public/assets/portal/announcements.js');
  const operations = read('apps/web/public/assets/portal/operations.js');
  assert.match(html, /data-view="announcements"/);
  assert.match(html, /id="announcement-form"/);
  assert.match(html, /class="announcement-operations-grid"/);
  assert.match(html, /id="announcement-preview-card"/);
  assert.match(html, /id="announcement-title-count"/);
  assert.match(html, /id="admin-system-version"/);
  assert.match(html, /id="check-update"/);
  assert.match(html, /id="install-update"/);
  assert.match(html, /id="repair-current"/);
  assert.match(html, /id="update-checked-at"/);
  assert.match(html, /id="update-source"/);
  assert.match(html, /安全更新最新版本/);
  assert.match(html, /data-view="tickets"/);
  assert.match(html, /id="admin-ticket-list"/);
  assert.match(html, /id="license-management-panel" class="license-management-modal" hidden/);
  assert.match(html, /id="close-license-manager"/);
  assert.doesNotMatch(html, /id="open-license-issue"|id="close-license-issue"/);
  assert.match(html, /data-go-view="licenses">＋ 签发授权/);
  assert.match(html, /id="version-search"/);
  assert.match(html, /id="logout" class="header-logout"/);
  assert.match(html, /<title>APPGOG · 运营中心<\/title>/);
  assert.match(html, /rel="icon" type="image\/svg\+xml" sizes="any" href="\/assets\/favicon\.svg\?v=1\.2\.27\.2"/);
  assert.match(html, /class="management-grid version-grid version-workbench"/);
  assert.match(html, /class="ticket-workspace support-workspace"/);
  assert.match(html, /class="management-grid member-grid"/);
  assert.match(html, /class="announcement-operations-grid"/);
  assert.doesNotMatch(html, /返回首页/);
  assert.doesNotMatch(html, /name="min_xboard_version"|name="min_upgrade_version"/);
  assert.doesNotMatch(html, /rollback_allowed|rollback_to|允许生成回滚包|推荐回滚版本/);
  assert.match(licenses, /function toggleLicenseKey/);
  assert.match(licenses, /license-key-eye/);
  assert.doesNotMatch(html, /id="managed-license-reveal"/);
  assert.match(licenses, /function closeLicenseManager/);
  assert.match(licenses, /event\.target === event\.currentTarget/);
  assert.match(licenses, /永久删除授权与全部记录/);
  assert.match(html, /name="plan_code"/);
  assert.match(script, /createAnnouncementUi/);
  assert.match(script, /createOperationsUi/);
  assert.match(announcements, /\/web\/admin\/announcement/);
  assert.match(announcements, /function preview/);
  assert.match(operations, /install-version/);
  assert.match(operations, /update\.installable/);
  assert.match(operations, /检查结果已过期/);
  assert.match(operations, /发布源落后/);
});

test('customer build UI keeps the version catalog in build tasks and removes migration notes', () => {
  const html = read('apps/web/public/build.html');
  const script = read('apps/web/public/assets/portal/customer-page.js');
  const buildsPage = html.indexOf('data-page="builds"');
  const catalog = html.indexOf('id="version-catalog"');
  assert.ok(buildsPage >= 0 && catalog > buildsPage);
  assert.doesNotMatch(html, /name="reason"/);
  assert.doesNotMatch(html, /＋ 新建构建/);
  assert.match(html, /id="customer-system-version"/);
  assert.match(html, /<title>APPGOG · 打包中心<\/title>/);
  assert.match(html, /rel="icon" type="image\/svg\+xml" sizes="any" href="\/assets\/favicon\.svg\?v=1\.2\.27\.2"/);
  assert.match(html, /class="ticket-workspace customer-ticket-workspace support-workspace"/);
  assert.match(html, /打包中心 · <strong id="customer-system-version"/);
  assert.match(html, /id="announcement-toggle"/);
  assert.match(html, /class="surface delivery-flow-card"/);
  assert.match(html, />交付步骤</);
  assert.match(html, />安装并正式激活</);
  assert.match(html, /data-view="tickets"/);
  assert.match(html, /data-view="lifecycle"/);
  assert.match(html, /同服务器重装 \/ 修复/);
  assert.match(html, /迁移到新服务器/);
  assert.match(html, /离线授权文件/);
  assert.match(html, /id="customer-ticket-form"/);
  assert.doesNotMatch(html, /生成回滚包|回滚构建/);
  assert.match(script, /renderCustomerTickets/);
  assert.match(script, /is_latest_eligible/);
  assert.match(script, /eligibility_reason/);
  assert.doesNotMatch(script, /renderAdminTickets|\/web\/admin\//);
  const ticketModule = read('apps/web/public/assets/portal/tickets.js');
  assert.match(ticketModule, /\/web\/customer\/tickets\/\$\{encodeURIComponent\(ticket\.id\)\}\/close/);
  assert.match(ticketModule, /重新打开工单/);
});

test('both centers load the shared design after their base styles and keep ticket creation in a dialog', () => {
  const admin = read('apps/web/public/admin.html');
  const customer = read('apps/web/public/build.html');
  for (const html of [admin, customer]) {
    assert.ok(html.indexOf('/assets/portal-design.css') > html.indexOf('/assets/site.css'));
    assert.match(html, /nav-icon[^>]*[^]*?<svg/);
  }
  const dialogStart = customer.indexOf('<dialog id="customer-ticket-dialog"');
  const dialogEnd = customer.indexOf('</dialog>', dialogStart);
  const form = customer.indexOf('id="customer-ticket-form"');
  assert.ok(dialogStart >= 0 && form > dialogStart && form < dialogEnd);
  assert.equal(customer.split('id="customer-ticket-form"').length, 2);
  assert.match(customer, /aria-labelledby="ticket-create-title"/);
  assert.match(customer, /id="open-customer-ticket"/);
  assert.match(customer, /id="cancel-customer-ticket"/);
});

test('browser favicon is a full-canvas dark rounded brand mark without a white backing', () => {
  const landing = read('apps/web/public/admin.html');
  const icon = read('apps/web/public/assets/favicon.svg');
  assert.match(landing, /rel="icon" type="image\/svg\+xml" sizes="any" href="\/assets\/favicon\.svg\?v=1\.2\.27\.2"/);
  assert.match(icon, /viewBox="0 0 64 64"/);
  assert.match(icon, /<rect width="64" height="64" rx="15" fill="#080d18"\/>/);
  assert.match(icon, /stroke="#25b6f6"/);
  assert.match(icon, /fill="#f0a12b"/);
  assert.doesNotMatch(icon, /#fff|#ffffff|white/i);
});

test('release publisher requires an explicit free or paid version tier and shared branding is dynamic', () => {
  const admin = read('apps/web/public/admin.html');
  const upload = read('apps/web/public/assets/portal/admin-release-upload.js');
  const shell = read('apps/web/public/assets/portal/shell.js');
  assert.match(admin, /name="access_tier"/);
  assert.match(admin, /免费授权可用/);
  assert.match(admin, /仅付费授权可用/);
  assert.match(upload, /access_tier/);
  assert.match(shell, /\/web\/branding/);
  assert.match(shell, /applyBranding/);
  assert.match(shell, /运营中心/);
  assert.match(shell, /打包中心/);
});

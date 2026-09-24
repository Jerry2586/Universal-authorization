import { $, can, mode, state } from './portal/core.js';
import { createApiClient } from './portal/api-client.js';
import {
  badge, button, channelLabel, date, element, fileSize, installationRoleLabel, intentLabel, match,
  progress, progressCell, releaseKindLabel, renderRows, roleLabel, search, td,
} from './portal/ui.js';
import { appendDialogActions, createDialog, showSecretDialog } from './portal/dialog.js';
import { createTicketUi } from './portal/tickets.js';
import { createLicenseUi } from './portal/licenses.js';
import { createMigrationUi } from './portal/migrations.js';
import { createAnnouncementUi } from './portal/announcements.js';
import { createMembersUi } from './portal/members.js';
import { createOperationsUi } from './portal/operations.js';

const { request, uploadZip, uploadTicketAttachment } = createApiClient({ state, onSessionInvalid: () => setView(false) });
const { renderCustomerTickets, renderAdminTickets } = createTicketUi({
  state, request, uploadTicketAttachment, notify, refresh, can,
});
const { licenseRow } = createLicenseUi({ request, notify, refresh, showSecret });
const migrationUi = createMigrationUi({ request, notify, showSecret, selectView });
const announcementUi = createAnnouncementUi({ request, notify, refresh });
const operationsUi = createOperationsUi({ request, notify, can });

function applyAdminPermissions(session) {
  if (mode !== 'admin') return;
  state.session = session;
  state.permissions = Array.isArray(session.permissions) ? session.permissions : [];
  const sections = { licenses: 'license.view', versions: 'version.view', builds: 'build.view', tickets: 'ticket.view', activations: 'activation.view', members: 'admin.manage', audit: 'audit.view', announcements: 'system.manage', migration: 'system.manage', cms: 'system.manage' };
  for (const [view, permission] of Object.entries(sections)) {
    const item = document.querySelector(`.nav-item[data-view="${view}"]`);
    if (item) item.hidden = !can(permission);
  }
  const licenseForm = $('license-form')?.closest('.form-surface');
  if (licenseForm) licenseForm.hidden = !can('license.issue');
  const versionForm = $('version-form')?.closest('.form-surface');
  if (versionForm) versionForm.hidden = !can('version.publish');
  const issueShortcut = document.querySelector('[data-go-view="licenses"]');
  if (issueShortcut) issueShortcut.hidden = !can('license.issue');
  const operator = document.querySelector('.operator-chip strong');
  if (operator) operator.textContent = session.display_name || session.username || '管理员';
  const role = document.querySelector('.operator-chip small');
  if (role) role.textContent = roleLabel(session.role);
  const avatar = document.querySelector('.operator-avatar');
  if (avatar) avatar.textContent = String(session.display_name || session.username || 'A').slice(0, 1).toUpperCase();
  const migrationNav = document.querySelector('.nav-item[data-view="migration"]');
  if (migrationNav) migrationNav.hidden = !can('system.manage') || !session.is_owner;
}

function notify(message, error = false) {
  const toast = $('message');
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.hidden = false;
  clearTimeout(state.notificationTimer);
  state.notificationTimer = setTimeout(() => { toast.hidden = true; }, 5000);
}

function setView(authenticated) {
  $('login-view').hidden = authenticated;
  $('dashboard-view').hidden = !authenticated;
  if (!authenticated) {
    state.data = null;
    history.replaceState(null, '', location.pathname);
  }
}

function selectView(view) {
  const page = [...document.querySelectorAll('.page-view')].find((item) => item.dataset.page === view);
  const nav = [...document.querySelectorAll('.nav-item')].find((item) => item.dataset.view === view);
  if (!page || nav?.hidden) return;
  for (const item of document.querySelectorAll('.page-view')) item.classList.toggle('active', item === page);
  for (const item of document.querySelectorAll('.nav-item')) {
    const active = item.dataset.view === view;
    item.classList.toggle('active', active);
    if (active) $('page-title').textContent = item.dataset.title;
    item.setAttribute('aria-current', active ? 'page' : 'false');
  }
  $('dashboard-view').classList.remove('nav-open');
  history.replaceState(null, '', `#${view}`);
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function detectedVersionFromFilename(name) {
  if (!/appgog/i.test(name ?? '')) return null;
  return String(name).replace(/\.zip$/i, '').match(/(?:^|[-_\s])v?(\d+\.\d+\.\d+)(?:$|[-_\s])/i)?.[1] ?? null;
}
function setSourceFile(file) {
  const input = $('source-zip');
  const zone = $('source-upload');
  if (!input || !zone) return;
  if (!file) {
    state.sourceFile = null;
    input.value = '';
    zone.classList.remove('has-file', 'upload-valid', 'upload-error');
    $('source-file-meta').hidden = true;
    $('source-upload-progress').hidden = true;
    $('source-upload-title').textContent = '点击选择或拖拽主题 ZIP 到这里';
    $('source-file-status').textContent = '最大 128 MB；上传后自动识别版本号和版本名称';
    return;
  }
  if (!/\.zip$/i.test(file.name) || file.type && !['application/zip', 'application/x-zip-compressed'].includes(file.type)) {
    setSourceFile(null);
    zone.classList.add('upload-error');
    $('source-file-status').textContent = '文件类型错误：只能上传 ZIP 安装包';
    throw new Error('只能上传 ZIP 安装包');
  }
  if (file.size > 128 * 1024 * 1024) {
    setSourceFile(null);
    zone.classList.add('upload-error');
    $('source-file-status').textContent = '文件超过 128 MB 限制';
    throw new Error('主题 ZIP 不能超过 128 MB');
  }
  state.sourceFile = file;
  zone.classList.add('has-file', 'upload-valid');
  zone.classList.remove('upload-error');
  $('source-file-name').textContent = file.name;
  $('source-file-size').textContent = fileSize(file.size);
  $('source-file-meta').hidden = false;
  $('source-upload-title').textContent = '主题 ZIP 已选择';
  const detected = detectedVersionFromFilename(file.name);
  const form = $('version-form');
  if (detected && form) {
    form.elements.version.value = detected;
    form.elements.display_name.value = `APPGOG ${detected}`;
    $('source-file-status').textContent = `已从文件名识别版本 ${detected}；服务端还会读取 config.json 最终校验`;
  } else {
    $('source-file-status').textContent = '未从文件名识别版本，请手动填写；服务端会优先读取 config.json 校验';
  }
}
const dialog = createDialog;
function actions(card, close, label, onConfirm, danger = false) {
  appendDialogActions({ card, close, label, onConfirm, danger, notify });
}
function showSecret(title, secret, description, downloadHref) {
  showSecretDialog({ title, secret, description, downloadHref, notify });
}
const membersUi = createMembersUi({
  request, notify, refresh, showSecret, openDialog: dialog, appendActions: actions,
});

function customerRow(job) {
  const row = element('tr');
  const version = element('td');
  version.append(element('strong', job.version || '—'), element('small', intentLabel(job.intent), 'table-subline'));
  row.append(version, td(job.domain), badge(job.status), progressCell(job.progress), td(date(job.created_at)));
  const action = element('td');
  action.append(button(job.status === 'succeeded' ? '领取交付' : '查看状态', () => showBuild(job.id)));
  row.append(action);
  return row;
}
async function createCustomerBuild(version, intent, trigger) {
  if (!state.data?.license?.bound_domain) return notify('当前授权尚未绑定域名', true);
  if (trigger) trigger.disabled = true;
  try {
    await request('/web/customer/builds', { method: 'POST', body: { version: version.version, domain: state.data.license.bound_domain, intent } });
    notify(`${intentLabel(intent)}已进入安全构建队列`);
    await refresh();
    selectView('builds');
  } catch (error) { notify(error.message, true); }
  finally { if (trigger?.isConnected) trigger.disabled = false; }
}
function customerVersionCard(version) {
  const item = element('article', null, `customer-version-card${version.is_latest ? ' latest' : ''}`);
  const top = element('div', null, 'version-card-top');
  const identity = element('div');
  const name = element('div', null, 'version-name-row');
  name.append(element('strong', version.display_name || `APPGOG ${version.version}`));
  if (version.is_latest) name.append(element('span', '最新版本', 'badge success'));
  if (version.is_current) name.append(element('span', '当前版本', 'badge'));
  identity.append(name, element('small', `${version.version || '—'} · ${channelLabel(version.channel)} · ${releaseKindLabel(version.release_kind)}`));
  top.append(identity, element('span', version.eligible === false ? '当前授权不可用' : '可构建', `status-pill ${version.eligible === false ? '' : 'status-success'}`));
  const notes = element('p', version.release_notes || '本版本暂无更新说明。', 'version-notes');
  const meta = element('div', null, 'version-meta');
  const footer = element('div', null, 'version-card-footer');
  const eligible = version.eligible !== false;
  let intent = 'update';
  let label = '构建更新包';
  if (version.is_current) { intent = 'reinstall'; label = '重新构建当前版本'; }
  const allowed = eligible && (version.is_latest || version.is_current);
  const action = button(allowed ? label : '历史版本仅供查看', () => createCustomerBuild(version, intent, action), `button ${version.is_current ? 'button-secondary' : 'button-primary'}`);
  action.disabled = !allowed;
  footer.append(element('small', date(version.created_at || version.published_at)), action);
  item.append(top, notes, meta, footer);
  return item;
}

function renderCustomer(data) {
  const license = data.license ?? {};
  const versions = Array.isArray(data.versions) ? data.versions : [];
  const builds = Array.isArray(data.builds) ? data.builds : [];
  const tickets = Array.isArray(data.tickets) ? data.tickets : [];
  $('license-status').textContent = license.status === 'active' ? '正常' : license.status;
  $('license-domain').textContent = license.bound_domain ?? '未绑定';
  $('header-domain').textContent = license.bound_domain ?? '未绑定域名';
  $('license-limit').textContent = license.max_builds_per_day == null
    ? '按授权策略'
    : `${license.builds_remaining ?? license.max_builds_per_day} / ${license.max_builds_per_day} 次`;
  $('license-product').textContent = String(license.product || license.product_code || 'APPGOG').toUpperCase();
  $('license-prefix').textContent = license.key_prefix ? `${license.key_prefix}••••` : '已验证';
  $('license-domain-detail').textContent = license.bound_domain ?? '未绑定';
  $('update-until').textContent = date(license.update_until);
  if ($('customer-system-version')) $('customer-system-version').textContent = data.system_version ? `v${data.system_version}` : 'v—';
  const announcement = data.announcement;
  const announcementBanner = $('announcement-banner');
  if (announcementBanner) {
    announcementBanner.hidden = !announcement;
    if (announcement) {
      announcementBanner.classList.remove('is-expanded');
      $('announcement-title').textContent = announcement.title || '平台公告';
      $('announcement-body').textContent = announcement.body || '';
      $('announcement-time').textContent = announcement.published_at ? `发布于 ${date(announcement.published_at)}` : '';
      const toggle = $('announcement-toggle');
      if (toggle) {
        toggle.hidden = !announcement.body || announcement.body.length <= 72;
        toggle.textContent = '查看详情';
        toggle.setAttribute('aria-expanded', 'false');
      }
    }
  }
  const bindPanel = $('domain-bind-panel');
  if (bindPanel) bindPanel.hidden = Boolean(license.bound_domain);
  const migrationPanel = $('domain-migration-panel');
  const migration = data.domain_migration;
  const migrationPolicy = data.domain_migration_policy ?? {};
  if (migrationPanel) migrationPanel.hidden = !license.bound_domain;
  const migrationForm = $('domain-migration-form');
  if (migrationForm) {
    const coolingDown = Boolean(migrationPolicy.cooldown_active);
    for (const control of migrationForm.elements) control.disabled = coolingDown;
    const status = $('domain-migration-status');
    if (status) status.textContent = coolingDown
      ? `上次换绑：${migration?.previous_domain ?? '—'} → ${migration?.requested_domain ?? license.bound_domain}；下次可换绑时间：${date(migrationPolicy.next_allowed_at)}`
      : migration?.reviewed_at
        ? `上次换绑完成于 ${date(migration.reviewed_at)}。确认后将立即使旧域名激活失效。`
        : '确认后立即换绑；旧域名授权随即失效，新域名需重新输入原固定 Key 激活。';
  }
  $('current-date').textContent = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
  const catalog = $('version-catalog');
  catalog.replaceChildren();
  if (!versions.length) {
    const empty = element('div', null, 'empty-state');
    empty.append(element('span', '▦'), element('strong', '暂无可用版本'), element('p', '授权管理员发布版本后会显示在这里。'));
    catalog.append(empty);
  } else {
    versions.filter((version) => version.is_latest || version.is_current).forEach((version) => catalog.append(customerVersionCard(version)));
  }
  renderRows('recent-build-list', builds.slice(0, 5), 6, customerRow, '还没有构建任务');
  const query = search('customer-build-search');
  renderRows('build-list', builds.filter((job) => match(job.version, query) || match(job.domain, query) || match(job.build_id, query) || match(intentLabel(job.intent), query)), 6, customerRow, '没有匹配的构建任务');
  renderCustomerTickets(tickets, builds);
}
async function showBuild(id) {
  try {
    const job = await request(`/web/customer/builds/${encodeURIComponent(id)}`);
    if (!job.install_key) { notify(`${job.message}（${job.progress}%）`, job.status === 'failed'); return; }
    const download = await request(`/web/customer/builds/${encodeURIComponent(id)}/download-ticket`, { method: 'POST' });
    showSecret('本次安装 Key', job.install_key, `Build ID：${job.build_id}。本 Key 只能成功激活一次；下载地址将在 5 分钟后失效。`, download.download_url);
  } catch (error) { notify(error.message, true); }
}

function migrationRow(requestItem) {
  const row = element('tr');
  row.append(td(requestItem.customer_ref), td(requestItem.previous_domain), td(requestItem.requested_domain), td(requestItem.reason), badge(requestItem.status), td(date(requestItem.requested_at)));
  const action = element('td', null, 'actions');
  if (requestItem.status === 'pending' && can('license.manage')) {
    action.append(
      button('批准', () => reviewDomainMigration(requestItem, 'approved')),
      button('拒绝', () => reviewDomainMigration(requestItem, 'rejected')),
    );
  }
  row.append(action);
  return row;
}
function reviewDomainMigration(requestItem, decision) {
  const approved = decision === 'approved';
  dialog(approved ? '批准域名迁移' : '拒绝域名迁移', `${requestItem.customer_ref}：${requestItem.previous_domain} → ${requestItem.requested_domain}`, (card, close) => {
    const label = element('label', null, 'field');
    label.append(element('span', '审批备注（可选）'));
    const input = element('textarea'); input.maxLength = 500; input.placeholder = approved ? '记录迁移窗口或注意事项' : '记录拒绝原因';
    label.append(input); card.append(label);
    actions(card, close, approved ? '确认批准' : '确认拒绝', async () => {
      await request(`/web/admin/domain-migrations/${encodeURIComponent(requestItem.id)}/review`, {
        method: 'POST', body: { decision, review_note: input.value.trim() },
      });
      notify(approved ? '域名迁移已批准' : '域名迁移已拒绝');
      await refresh();
    }, !approved);
  });
}
function buildRow(job) {
  const row = element('tr');
  row.append(td(job.build_id || job.id, 'key-inline'), td(job.version), td(job.domain), badge(job.status), progressCell(job.progress), td(job.message), td(date(job.created_at)));
  return row;
}
function renderAdmin(data) {
  const stats = data.stats ?? {};
  const licenses = Array.isArray(data.licenses) ? data.licenses : [];
  const versions = Array.isArray(data.versions) ? data.versions : [];
  const builds = Array.isArray(data.builds) ? data.builds : [];
  const activations = Array.isArray(data.activations) ? data.activations : [];
  const migrations = Array.isArray(data.domain_migrations) ? data.domain_migrations : [];
  const audit = Array.isArray(data.audit) ? data.audit : [];
  const admins = Array.isArray(data.admins) ? data.admins : [];
  const tickets = Array.isArray(data.tickets) ? data.tickets : [];
  const cms = data.cms ?? {};
  const nodes = Array.isArray(cms.nodes) ? cms.nodes : [];
  if ($('admin-system-version')) $('admin-system-version').textContent = cms.system_version ? `v${cms.system_version}` : 'v—';
  $('stat-licenses').textContent = stats.licenses ?? licenses.length;
  $('stat-active').textContent = stats.activeLicenses ?? licenses.filter((item) => item.status === 'active').length;
  $('stat-builds').textContent = stats.buildsToday ?? 0;
  $('stat-activations').textContent = stats.activeActivations ?? activations.filter((item) => item.status === 'active').length;
  $('stat-queued').textContent = stats.queuedJobs ?? builds.filter((item) => item.status === 'queued').length;
  $('stat-versions').textContent = versions.filter((item) => item.status === 'active').length;
  renderRows('overview-build-list', builds.slice(0, 5), 4, (job) => { const row = element('tr'); row.append(td(job.version), td(job.domain), badge(job.status), progressCell(job.progress)); return row; });
  renderRows('overview-license-list', licenses.slice(0, 5), 5, (license) => { const row = element('tr'); row.append(td(license.customer_ref), td(license.bound_domain), badge(license.status), td(license.build_count), td(date(license.created_at))); return row; });
  const licenseQuery = search('license-search');
  const licenseStatus = $('license-status-filter').value;
  renderRows('license-list', licenses.filter((license) => (!licenseStatus || license.status === licenseStatus) && [license.customer_ref, license.bound_domain, license.key_prefix, license.plan_name, license.plan_code].some((value) => match(value, licenseQuery))), 8, licenseRow, '没有匹配的授权');
  if ($('migration-count')) $('migration-count').textContent = `${migrations.length} 条记录`;
  if ($('migration-list')) renderRows('migration-list', migrations, 7, migrationRow, '暂无域名迁移申请');
  const list = $('version-list');
  if ($('version-count')) $('version-count').textContent = `${versions.length} 个版本`;
  if ($('version-total')) $('version-total').textContent = versions.length;
  if ($('version-active')) $('version-active').textContent = versions.filter((item) => item.status === 'active').length;
  if ($('version-draft')) $('version-draft').textContent = versions.filter((item) => item.status !== 'active').length;
  const versionQuery = search('version-search');
  const versionStatus = $('version-status-filter')?.value || '';
  const visibleVersions = versions.filter((version) => (!versionStatus || version.status === versionStatus)
    && [version.version, version.display_name, version.release_notes].some((value) => match(value, versionQuery)));
  list.replaceChildren();
  if (!visibleVersions.length) {
    const empty = element('div', null, 'empty-state');
    empty.append(element('span', '▦'), element('strong', '尚未发布版本'), element('p', '上传第一个正式主题包后，客户才能创建构建。'));
    list.append(empty);
  }
  for (const [index, version] of visibleVersions.entries()) {
    const item = element('article', null, 'release-item compact-release-item');
    const summary = element('div', null, 'release-summary');
    const title = element('div', null, 'version-name-row');
    title.append(element('strong', version.display_name || `APPGOG ${version.version}`));
    if (index === 0 && version.status === 'active') title.append(element('span', '最新', 'badge success'));
    summary.append(title, element('small', `${version.version || '—'} · ${channelLabel(version.channel)} · ${releaseKindLabel(version.release_kind)} · ${date(version.published_at || version.created_at)}`), element('p', version.release_notes || '暂无更新公告'));
    const meta = element('div', null, 'release-meta');
    meta.append(element('span', version.source_kind === 'official' ? '真实源码 ZIP' : version.source_kind || '源码未知'));
    summary.append(meta);
    const side = element('div', null, 'release-side');
    side.append(element('span', version.status === 'active' ? '已发布' : '草稿', `badge ${version.status === 'active' ? 'success' : ''}`));
    if (version.status === 'active' && can('version.manage')) side.append(button('撤回版本', () => withdrawVersion(version), 'mini-button mini-button-danger'));
    item.append(summary, side);
    list.append(item);
  }
  const buildQuery = search('admin-build-search');
  const buildStatus = $('build-status-filter').value;
  renderRows('admin-build-list', builds.filter((job) => (!buildStatus || job.status === buildStatus) && [job.version, job.domain, job.build_id, job.id].some((value) => match(value, buildQuery))), 7, buildRow, '没有匹配的构建任务');
  renderAdminTickets(tickets, admins);
  const activationQuery = search('activation-search');
  renderRows('activation-list', activations.filter((item) => [item.customer_ref, item.domain, item.backend_origin, item.version].some((value) => match(value, activationQuery))), 7, (item) => { const row = element('tr'); row.append(td(item.customer_ref), td(item.version), td(item.domain), td(item.backend_origin), badge(item.status), td(date(item.last_seen_at)), td(date(item.created_at))); return row; }, '没有匹配的激活站点');
  membersUi.render(admins, nodes);
  const auditQuery = search('audit-search');
  renderRows('audit-list', audit.filter((item) => [item.action, item.actor_type, item.actor_id, item.subject_type, item.subject_id].some((value) => match(value, auditQuery))), 6, (item) => { const row = element('tr'); row.append(td(item.action), td(item.actor_type), td(item.actor_id), td(item.subject_type), td(item.subject_id), td(date(item.created_at))); return row; }, '没有匹配的审计记录');
  const cmsForm = $('cms-settings-form');
  if (cmsForm) {
    for (const key of ['platform_name', 'domain_migration_cooldown_hours']) {
      if (cmsForm.elements[key]) cmsForm.elements[key].value = cms[key] ?? '';
    }
  }
  announcementUi.render(cms);
  if ($('cms-role-badge')) $('cms-role-badge').textContent = installationRoleLabel(cms.installation_role);
  if ($('cms-license-url')) $('cms-license-url').textContent = cms.license_public_url ?? '—';
  if ($('cms-build-url')) $('cms-build-url').textContent = cms.build_public_url ?? '—';
  if ($('cms-installation-role')) $('cms-installation-role').textContent = installationRoleLabel(cms.installation_role);
  if ($('cms-service-status')) $('cms-service-status').textContent = [
    cms.license_service_enabled !== false ? '授权服务在线' : '授权服务停用',
    cms.build_center_enabled !== false ? '打包中心在线' : '打包中心停用',
    cms.worker_enabled !== false ? 'Worker 在线' : 'Worker 停用',
  ].join(' · ');
  operationsUi.refresh();
}

function withdrawVersion(version) {
  dialog('撤回主题版本', `${version.display_name || version.version} 撤回后不再允许客户创建新构建，历史数据不会删除。`, (card, close) => {
    const label = element('label', null, 'field'); label.append(element('span', '撤回原因（至少 8 个字）'));
    const input = element('textarea'); input.required = true; input.minLength = 8; input.maxLength = 500; label.append(input); card.append(label);
    actions(card, close, '确认撤回', async () => {
      await request(`/web/admin/versions/${encodeURIComponent(version.id)}/withdraw`, { method: 'POST', body: { reason: input.value.trim() } });
      notify('版本已撤回'); await refresh();
    }, true);
  });
}

async function refresh() {
  if (state.loading || !state.csrf) return;
  state.loading = true;
  try {
    const data = await request(`/web/${mode}/overview`);
    state.data = data;
    if (mode === 'customer') renderCustomer(data); else renderAdmin(data);
  } catch (error) { notify(error.message, true); }
  finally { state.loading = false; }
}

document.querySelectorAll('[data-view]').forEach((item) => item.addEventListener('click', () => selectView(item.dataset.view)));
document.querySelectorAll('[data-go-view]').forEach((item) => item.addEventListener('click', () => selectView(item.dataset.goView)));
document.querySelector('.mobile-menu')?.addEventListener('click', () => $('dashboard-view').classList.toggle('nav-open'));
$('announcement-toggle')?.addEventListener('click', () => {
  const banner = $('announcement-banner');
  const toggle = $('announcement-toggle');
  const expanded = !banner.classList.contains('is-expanded');
  banner.classList.toggle('is-expanded', expanded);
  toggle.textContent = expanded ? '收起内容' : '查看详情';
  toggle.setAttribute('aria-expanded', String(expanded));
});
document.addEventListener('click', (event) => {
  if (event.target === $('dashboard-view') && $('dashboard-view').classList.contains('nav-open')) $('dashboard-view').classList.remove('nav-open');
  const accountMenu = $('account-menu');
  const accountToggle = $('account-menu-toggle');
  if (accountMenu && accountToggle && !accountMenu.hidden && !accountToggle.closest('.account-menu')?.contains(event.target)) {
    accountMenu.hidden = true;
    accountToggle.setAttribute('aria-expanded', 'false');
  }
});

function openAccountCenter() {
  const menu = $('account-menu');
  if (menu) menu.hidden = true;
  $('account-menu-toggle')?.setAttribute('aria-expanded', 'false');
  dialog('用户中心', '修改当前管理员密码。密码修改后所有已登录设备会立即退出，需要使用新密码重新登录。', (card, close) => {
    const form = element('form', null, 'form-stack');
    const fields = [
      ['current_password', '当前密码', 'current-password'],
      ['new_password', '新密码（6 位数字）', 'new-password'],
      ['confirm_password', '确认新密码', 'new-password'],
    ];
    for (const [name, labelText, autocomplete] of fields) {
      const label = element('label', null, 'field');
      label.append(element('span', labelText));
      const input = element('input');
      input.name = name;
      input.type = 'password';
      input.autocomplete = autocomplete;
      input.inputMode = 'numeric';
      input.required = true;
      if (name !== 'current_password') { input.minLength = 6; input.maxLength = 6; input.pattern = '[0-9]{6}'; }
      label.append(input);
      form.append(label);
    }
    const row = element('div', null, 'dialog-actions');
    row.append(button('取消', close, 'button button-secondary'));
    const submit = element('button', '保存新密码', 'button button-primary');
    submit.type = 'submit';
    row.append(submit);
    form.append(row);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      submit.disabled = true;
      try {
        const data = new FormData(form);
        await request('/web/admin/account/password', { method: 'POST', body: Object.fromEntries(data) });
        close();
        state.csrf = null;
        state.permissions = [];
        state.session = null;
        setView(false);
        notify('密码修改成功，请使用新密码重新登录');
      } catch (error) { notify(error.message, true); }
      finally { submit.disabled = false; }
    });
    card.append(form);
  });
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  const loginError = $('login-error');
  const submitLabel = $('login-submit-label');
  if (loginError) { loginError.hidden = true; loginError.textContent = ''; }
  if (submitLabel) submitLabel.textContent = mode === 'customer' ? '正在验证…' : '正在登录…';
  form.setAttribute('aria-busy', 'true');
  submit.disabled = true;
  try {
    const fields = new FormData(form);
    const body = mode === 'customer' ? { license_key: fields.get('license_key') } : { username: fields.get('username'), password: fields.get('password') };
    const result = await request(`/web/${mode}/login`, { method: 'POST', body });
    state.csrf = result.csrf_token;
    state.session = result;
    applyAdminPermissions(result);
    form.reset();
    setView(true);
    selectView('overview');
    await refresh();
  } catch (error) {
    if (loginError && !$('login-view').hidden) { loginError.textContent = error.message; loginError.hidden = false; }
    else notify(error.message, true);
  }
  finally {
    submit.disabled = false;
    form.removeAttribute('aria-busy');
    if (submitLabel) submitLabel.textContent = mode === 'customer' ? '验证并进入' : '登录后台';
  }
});
$('logout').addEventListener('click', async () => {
  try { await request(`/web/logout?actor=${mode}`, { method: 'POST' }); }
  catch (error) { notify(error.message, true); }
  state.csrf = null;
  state.permissions = [];
  state.session = null;
  setView(false);
});

if (mode === 'customer') {
  $('refresh-customer').addEventListener('click', refresh);
  $('customer-build-search').addEventListener('input', () => { if (state.data) renderCustomer(state.data); });
  $('customer-ticket-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const fields = new FormData(form);
      const ticket = await request('/web/customer/tickets', { method: 'POST', body: {
        category: fields.get('category'), priority: fields.get('priority'), build_job_id: fields.get('build_job_id') || null,
        subject: fields.get('subject'), body: fields.get('body'),
      } });
      const file = $('customer-ticket-file')?.files?.[0];
      await uploadTicketAttachment(`/web/customer/tickets/${encodeURIComponent(ticket.id)}/attachments`, file);
      state.selectedCustomerTicketId = ticket.id;
      form.reset(); notify('工单已提交'); await refresh(); selectView('tickets');
    } catch (error) { notify(error.message, true); }
    finally { submit.disabled = false; }
  });
  $('domain-bind-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const fields = new FormData(form);
      await request('/web/customer/domain/bind', { method: 'POST', body: { domain: String(fields.get('domain') || '').trim() } });
      form.reset(); notify('授权域名已完成首次绑定'); await refresh();
    } catch (error) { notify(error.message, true); }
    finally { submit.disabled = false; }
  });
  $('domain-migration-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('[type="submit"]');
    const fields = new FormData(form);
    const nextDomain = String(fields.get('domain') || '').trim();
    dialog('确认立即更换授权域名', `当前域名 ${state.data?.license?.bound_domain ?? '—'} 将立即失效，并切换到 ${nextDomain}。固定 Key 不变，但新域名必须重新输入原 Key 激活。`, (card, close) => {
      actions(card, close, '确认立即换绑', async () => {
        submit.disabled = true;
        try {
          await request('/web/customer/domain-migrations', { method: 'POST', body: { domain: nextDomain } });
          form.reset();
          notify('域名换绑已完成；请在新域名重新输入原固定 Key 激活');
          await refresh();
        } finally { submit.disabled = false; }
      }, true);
    });
  });
  setInterval(() => {
    if (!document.hidden && !$('dashboard-view').hidden && state.data?.builds?.some((job) => ['queued', 'processing'].includes(job.status))) refresh();
  }, 5000);
} else {
  migrationUi.bind();
  membersUi.bind();
  announcementUi.bind();
  operationsUi.bind();
  $('open-account-center')?.addEventListener('click', openAccountCenter);
  $('refresh-admin').addEventListener('click', refresh);
  const uploadZone = $('source-upload');
  const sourceInput = $('source-zip');
  if (uploadZone && sourceInput) {
    uploadZone.addEventListener('click', (event) => { if (!event.target.closest('#source-file-remove')) sourceInput.click(); });
    uploadZone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); sourceInput.click(); }
    });
    sourceInput.addEventListener('change', () => {
      try { setSourceFile(sourceInput.files?.[0] ?? null); } catch (error) { notify(error.message, true); }
    });
    for (const eventName of ['dragenter', 'dragover']) uploadZone.addEventListener(eventName, (event) => {
      event.preventDefault(); uploadZone.classList.add('is-dragging');
    });
    for (const eventName of ['dragleave', 'drop']) uploadZone.addEventListener(eventName, (event) => {
      event.preventDefault(); uploadZone.classList.remove('is-dragging');
    });
    uploadZone.addEventListener('drop', (event) => {
      try { setSourceFile(event.dataTransfer?.files?.[0] ?? null); } catch (error) { notify(error.message, true); }
    });
    $('source-file-remove')?.addEventListener('click', (event) => { event.stopPropagation(); setSourceFile(null); });
  }
  for (const id of ['license-search', 'license-status-filter', 'version-search', 'version-status-filter', 'admin-build-search', 'build-status-filter', 'admin-ticket-search', 'admin-ticket-status-filter', 'activation-search', 'audit-search']) {
    $(id)?.addEventListener(id.includes('filter') ? 'change' : 'input', () => { if (state.data) renderAdmin(state.data); });
  }
  $('license-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const fields = new FormData(form);
      const until = fields.get('update_until');
      const result = await request('/web/admin/licenses', { method: 'POST', body: {
        product_code: 'appgog', customer_ref: fields.get('customer_ref'), domain: fields.get('domain'),
        plan_code: fields.get('plan_code'),
        update_until: until ? new Date(`${until}T23:59:59Z`).toISOString() : null,
        max_builds_per_day: Number(fields.get('max_builds_per_day')),
        max_activations: Number(fields.get('max_activations')),
      } });
      form.reset();
      showSecret('新的固定授权 Key', result.license_key, '请安全交给客户。Key 已加密保存，仅平台所有者重新验证密码后可以查看。');
      await refresh();
    } catch (error) { notify(error.message, true); }
    finally { submit.disabled = false; }
  });
  $('license-plan')?.addEventListener('change', (event) => {
    const form = event.currentTarget.form;
    const buildLimit = form.elements.max_builds_per_day;
    const activationLimit = form.elements.max_activations;
    if (event.currentTarget.value === 'free') {
      buildLimit.value = '1'; buildLimit.max = '1';
      activationLimit.value = '1'; activationLimit.max = '1';
    } else {
      buildLimit.max = '10'; activationLimit.max = '3';
      if (Number(buildLimit.value) < 1) buildLimit.value = '3';
      if (Number(activationLimit.value) < 1) activationLimit.value = '1';
    }
  });
  $('version-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const fields = new FormData(form);
      const file = state.sourceFile ?? fields.get('source_zip');
      if (!(file instanceof File) || !file.size) throw new Error('请选择主题 ZIP');
      const params = new URLSearchParams({
        product_code: 'appgog',
        source_filename: file.name,
        version: String(fields.get('version')),
        display_name: String(fields.get('display_name') || ''),
        release_notes: String(fields.get('release_notes') || ''),
        channel: String(fields.get('channel') || 'stable'),
        release_kind: String(fields.get('release_kind') || 'feature'),
      });
      const progressWrap = $('source-upload-progress');
      const progressFill = $('source-upload-progress-fill');
      const progressText = $('source-upload-progress-text');
      progressWrap.hidden = false;
      $('source-file-status').textContent = '正在上传并执行 ZIP 安全检查…';
      const result = await uploadZip(`/web/admin/versions/upload?${params}`, file, (percent) => {
        progressFill.style.width = `${percent}%`;
        progressText.textContent = `${percent}%`;
      });
      progressFill.style.width = '100%';
      progressText.textContent = '校验通过';
      form.reset();
      setSourceFile(null);
      notify(`${result.display_name || result.version} 安全检查通过，版本已发布`);
      await refresh();
    } catch (error) { notify(error.message, true); }
    finally { submit.disabled = false; }
  });
  $('cms-settings-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const fields = new FormData(form);
      await request('/web/admin/cms/settings', { method: 'POST', body: {
        platform_name: String(fields.get('platform_name') || '').trim(),
        domain_migration_cooldown_hours: Number(fields.get('domain_migration_cooldown_hours')),
      } });
      notify('运营设置已保存');
      await refresh();
    } catch (error) { notify(error.message, true); }
    finally { submit.disabled = false; }
  });
}

request(`/web/session?actor=${mode}`).then((session) => {
  if (session.actor !== mode) return;
  state.csrf = session.csrf_token;
  state.session = session;
  applyAdminPermissions(session);
  setView(true);
  const requested = location.hash.slice(1);
  selectView([...document.querySelectorAll('.page-view')].some((item) => item.dataset.page === requested) ? requested : 'overview');
  refresh();
  if (mode === 'admin' && session.is_owner) migrationUi.refresh();
}).catch(() => setView(false));

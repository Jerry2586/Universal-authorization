const mode = document.body.dataset.portal;
const $ = (id) => document.getElementById(id);
const state = { csrf: null, data: null, loading: false, notificationTimer: null, permissions: [], session: null };

function can(permission) { return mode === 'admin' && (state.permissions.includes('*') || state.permissions.includes(permission)); }

function applyAdminPermissions(session) {
  if (mode !== 'admin') return;
  state.session = session;
  state.permissions = Array.isArray(session.permissions) ? session.permissions : [];
  const sections = { licenses: 'license.view', versions: 'version.view', builds: 'build.view', activations: 'activation.view', members: 'admin.manage', audit: 'audit.view', announcements: 'system.manage', cms: 'system.manage' };
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
}

async function request(path, { method = 'GET', body, raw = false } = {}) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(raw ? { 'content-type': 'application/zip' } : body ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' && state.csrf && !path.endsWith('/login') ? { 'x-csrf-token': state.csrf } : {}),
    },
    ...(body !== undefined ? { body: raw ? body : JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 || response.status === 403 && result.error?.code === 'SESSION_INVALID') {
      state.csrf = null;
      setView(false);
    }
    throw new Error(result.error?.message ?? `请求失败 (${response.status})`);
  }
  return result;
}

function uploadZip(path, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.responseType = 'json';
    xhr.withCredentials = true;
    xhr.setRequestHeader('content-type', 'application/zip');
    if (state.csrf) xhr.setRequestHeader('x-csrf-token', state.csrf);
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
    });
    xhr.addEventListener('load', () => {
      const result = xhr.response ?? (() => { try { return JSON.parse(xhr.responseText); } catch { return {}; } })();
      if (xhr.status >= 200 && xhr.status < 300) return resolve(result);
      if (xhr.status === 401 || xhr.status === 403 && result.error?.code === 'SESSION_INVALID') {
        state.csrf = null;
        state.session = null;
        setView(false);
      }
      reject(new Error(result.error?.message ?? `上传失败 (${xhr.status})`));
    });
    xhr.addEventListener('error', () => reject(new Error('网络连接中断，主题 ZIP 上传失败')));
    xhr.addEventListener('abort', () => reject(new Error('主题 ZIP 上传已取消')));
    xhr.send(file);
  });
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

function date(value) {
  if (!value) return '未设置';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString('zh-CN');
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

function td(value, className) { return element('td', value == null || value === '' ? '—' : value, className); }
function badge(status) {
  const value = { active: '正常', inactive: '已停用', disabled: '已停用', suspended: '已暂停', revoked: '已撤销', queued: '排队中', processing: '构建中', succeeded: '已完成', failed: '失败', draft: '草稿' }[status] ?? status ?? '—';
  const cell = element('td');
  cell.append(element('span', value, `badge ${['active', 'succeeded'].includes(status) ? 'success' : ['revoked', 'failed'].includes(status) ? 'failed' : ['processing', 'suspended'].includes(status) ? 'processing' : ''}`));
  return cell;
}
function roleLabel(role) { return { owner: '平台所有者', super_admin: '超级管理员', license_ops: '授权运营', license_operator: '授权运营', release_manager: '版本管理员', support: '客服管理员', auditor: '审计员' }[role] ?? role ?? '未分配'; }
function nodeRoleLabel(role) { return { 'build-center': '打包中心', worker: '构建 Worker' }[role] ?? role ?? '未知节点'; }
function installationRoleLabel(role) { return { 'all-in-one': '完整系统', 'license-center': '授权中心', 'build-center': '打包中心', worker: '构建 Worker' }[role] ?? role ?? '未设置'; }
function channelLabel(channel) { return { stable: '正式版', beta: '测试版', preview: '预览版' }[channel] ?? channel ?? '正式版'; }
function releaseKindLabel(kind) { return { feature: '功能更新', security: '安全更新', hotfix: '问题修复' }[kind] ?? kind ?? '常规更新'; }
function intentLabel(intent) { return { update: '更新包', rollback: '回滚包', reinstall: '重装包' }[intent] ?? '安装包'; }
function renderRows(id, items, count, render, empty = '暂无记录') {
  const target = $(id);
  target.replaceChildren();
  if (!items.length) {
    const row = element('tr');
    const emptyCell = td(empty, 'empty-cell');
    emptyCell.colSpan = count;
    row.append(emptyCell);
    target.append(row);
    return;
  }
  for (const item of items) target.append(render(item));
}
function match(value, query) { return String(value ?? '').toLocaleLowerCase().includes(query); }
function search(id) { return ($(id)?.value ?? '').trim().toLocaleLowerCase(); }
function fileSize(value) {
  const size = Number(value) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
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
function button(text, action, className = 'mini-button') {
  const node = element('button', text, className);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}
function progress(value) {
  const wrap = element('span');
  const track = element('span', null, 'progress-track');
  const fill = element('span', null, 'progress-fill');
  fill.style.width = `${Math.min(100, Math.max(0, Number(value) || 0))}%`;
  track.append(fill);
  wrap.append(track, element('span', `${value ?? 0}%`, 'progress-label'));
  return wrap;
}
function progressCell(value) { const node = element('td'); node.append(progress(value)); return node; }
function closeDialog(overlay) {
  overlay.dataset.closing = '';
  setTimeout(() => overlay.remove(), 220);
}
function dialog(title, description, build) {
  const overlay = element('div', null, 'modal-overlay');
  const card = element('div', null, 'modal-card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  const heading = element('h2', title);
  heading.id = 'dialog-heading';
  card.setAttribute('aria-labelledby', heading.id);
  card.append(heading, element('p', description));
  build(card, () => closeDialog(overlay));
  overlay.append(card);
  overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) closeDialog(overlay); });
  const onKey = (event) => { if (event.key === 'Escape') { closeDialog(overlay); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('transitionend', () => { if (!overlay.isConnected) document.removeEventListener('keydown', onKey); });
  document.body.append(overlay);
  card.querySelector('input,button,a')?.focus();
  return { card, close: () => closeDialog(overlay) };
}
function actions(card, close, label, onConfirm, danger = false) {
  const row = element('div', null, 'dialog-actions');
  row.append(button('取消', close, 'button button-secondary'));
  const confirm = button(label, async () => {
    confirm.disabled = true;
    try { await onConfirm(); close(); } catch (error) { notify(error.message, true); }
    finally { confirm.disabled = false; }
  }, `button ${danger ? 'button-danger' : 'button-primary'}`);
  row.append(confirm);
  card.append(row);
}
function showSecret(title, secret, description, downloadHref) {
  dialog(title, description, (card, close) => {
    card.append(element('code', secret, 'key-code'));
    const row = element('div', null, 'dialog-actions');
    row.append(button('复制 Key', async () => {
      try { await navigator.clipboard.writeText(secret); notify('已复制到剪贴板'); }
      catch { notify('复制失败，请手动选择并复制', true); }
    }, 'button button-secondary'));
    if (downloadHref) {
      const link = element('a', '下载主题 ZIP →', 'button button-primary');
      link.href = downloadHref;
      row.append(link);
    }
    row.append(button('关闭', close, 'button button-secondary'));
    card.append(row);
  });
}

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
  if (version.rollback_to) meta.append(element('span', `建议回滚至 ${version.rollback_to}`));
  const footer = element('div', null, 'version-card-footer');
  const eligible = version.eligible !== false;
  let intent = 'update';
  let label = '构建更新包';
  if (version.is_current) { intent = 'reinstall'; label = '重新构建当前版本'; }
  else if (!version.is_latest) { intent = 'rollback'; label = '生成回滚包'; }
  const allowed = eligible && (intent !== 'rollback' || version.rollback_allowed !== false);
  const action = button(allowed ? label : intent === 'rollback' ? '此版本不可回滚' : '当前授权不可构建', () => createCustomerBuild(version, intent, action), `button ${intent === 'rollback' ? 'button-secondary' : 'button-primary'}`);
  action.disabled = !allowed;
  footer.append(element('small', date(version.created_at || version.published_at)), action);
  item.append(top, notes, meta, footer);
  return item;
}
function renderCustomer(data) {
  const license = data.license ?? {};
  const versions = Array.isArray(data.versions) ? data.versions : [];
  const builds = Array.isArray(data.builds) ? data.builds : [];
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
  const announcement = data.announcement;
  const announcementBanner = $('announcement-banner');
  if (announcementBanner) {
    announcementBanner.hidden = !announcement;
    if (announcement) {
      $('announcement-title').textContent = announcement.title || '平台公告';
      $('announcement-body').textContent = announcement.body || '';
      $('announcement-time').textContent = announcement.published_at ? `发布于 ${date(announcement.published_at)}` : '';
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
    versions.forEach((version) => catalog.append(customerVersionCard(version)));
  }
  renderRows('recent-build-list', builds.slice(0, 5), 6, customerRow, '还没有构建任务');
  const query = search('customer-build-search');
  renderRows('build-list', builds.filter((job) => match(job.version, query) || match(job.domain, query) || match(job.build_id, query) || match(intentLabel(job.intent), query)), 6, customerRow, '没有匹配的构建任务');
}
async function showBuild(id) {
  try {
    const job = await request(`/web/customer/builds/${encodeURIComponent(id)}`);
    if (!job.install_key) { notify(`${job.message}（${job.progress}%）`, job.status === 'failed'); return; }
    const download = await request(`/web/customer/builds/${encodeURIComponent(id)}/download-ticket`, { method: 'POST' });
    showSecret('本次安装 Key', job.install_key, `Build ID：${job.build_id}。本 Key 只能成功激活一次；下载地址将在 5 分钟后失效。`, download.download_url);
  } catch (error) { notify(error.message, true); }
}

function licenseRow(license) {
  const row = element('tr');
  const keyCell = element('td');
  const keyWrap = element('div', null, 'key-preview');
  keyWrap.append(element('code', `${license.key_prefix}••••`));
  if (can('license.manage') && state.session?.is_owner) {
    const reveal = button('查看', () => revealLicenseKey(license), 'key-reveal-button');
    reveal.title = license.key_recoverable ? '重新验证密码后查看完整 Key' : '历史 Key 需要先轮换才能查看';
    keyWrap.append(reveal);
  }
  keyCell.append(keyWrap);
  row.append(td(license.customer_ref), keyCell, td(license.bound_domain), badge(license.status), td(license.build_count), td(license.active_activation_count));
  const action = element('td', null, 'actions');
  if (can('license.manage')) action.append(button('换域名', () => changeDomain(license)), button('轮换 Key', () => confirmAction(license, 'rotate')));
  if (can('license.manage') && license.status !== 'revoked') {
    action.append(button(license.status === 'active' ? '暂停' : '恢复', () => confirmAction(license, license.status === 'active' ? 'suspended' : 'active')));
    action.append(button('撤销', () => confirmAction(license, 'revoked')));
  }
  row.append(action);
  return row;
}
function revealLicenseKey(license) {
  dialog('查看完整固定 Key', license.key_recoverable ? '请输入当前管理员密码。完整 Key 显示后不会写入日志。' : '该历史 Key 只保存了不可逆哈希，必须先轮换 Key 才能查看。', (card, close) => {
    if (!license.key_recoverable) {
      const row = element('div', null, 'dialog-actions');
      row.append(button('关闭', close, 'button button-secondary'));
      card.append(row);
      return;
    }
    const form = element('form', null, 'form-stack');
    const label = element('label', null, 'field');
    label.append(element('span', '当前管理员密码'));
    const input = element('input'); input.type = 'password'; input.autocomplete = 'current-password'; input.required = true;
    label.append(input); form.append(label);
    const row = element('div', null, 'dialog-actions');
    row.append(button('取消', close, 'button button-secondary'));
    const submit = element('button', '验证并查看', 'button button-primary'); submit.type = 'submit'; row.append(submit); form.append(row);
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); submit.disabled = true;
      try {
        const result = await request(`/web/admin/licenses/${encodeURIComponent(license.id)}/key`, { method: 'POST', body: { password: input.value } });
        close(); setTimeout(() => showSecret('完整固定授权 Key', result.license_key, '查看操作已写入审计记录，审计中不会保存 Key 明文。'), 230);
      } catch (error) { notify(error.message, true); }
      finally { submit.disabled = false; }
    });
    card.append(form);
  });
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
function adminRow(admin) {
  const row = element('tr');
  const member = element('td');
  const identity = element('div', null, 'member-identity');
  const avatar = element('span', String(admin.display_name || admin.username || 'A').slice(0, 1).toUpperCase(), 'member-avatar');
  const name = element('div');
  name.append(element('strong', admin.display_name || admin.username || '未命名管理员'));
  if (admin.is_owner || admin.role === 'owner') name.append(element('small', '平台所有者'));
  identity.append(avatar, name);
  member.append(identity);
  const status = admin.status || (admin.active === false ? 'suspended' : 'active');
  row.append(member, td(admin.username), td(roleLabel(admin.role)), badge(status), td(date(admin.last_login_at)));
  const action = element('td', null, 'actions');
  if (admin.is_owner || admin.role === 'owner') {
    action.append(element('span', '受保护账号', 'table-muted'));
  } else if (admin.id === state.session?.id) {
    action.append(element('span', '当前账号', 'table-muted'));
  } else {
    const next = status === 'active' ? 'suspended' : 'active';
    action.append(button(next === 'active' ? '恢复账号' : '停用账号', async (event) => {
      const trigger = event.currentTarget;
      trigger.disabled = true;
      try {
        await request(`/web/admin/admins/${encodeURIComponent(admin.id)}/status`, { method: 'POST', body: { status: next } });
        notify(next === 'active' ? '管理员账号已恢复' : '管理员账号已停用');
        await refresh();
      } catch (error) { notify(error.message, true); }
      finally { if (trigger.isConnected) trigger.disabled = false; }
    }));
    action.append(button('删除账号', () => {
      dialog('删除管理员账号', `将删除“${admin.display_name || admin.username}”的登录权限，并立即撤销其全部会话。历史审计记录会继续保留。`, (card, close) => {
        actions(card, close, '确认删除', async () => {
          await request(`/web/admin/admins/${encodeURIComponent(admin.id)}`, { method: 'DELETE' });
          notify('管理员账号已删除');
          await refresh();
        }, true);
      });
    }, 'mini-button mini-button-danger'));
  }
  row.append(action);
  return row;
}
function nodeRow(node) {
  const row = element('tr');
  const identity = element('td');
  const name = element('div', null, 'node-identity');
  name.append(element('strong', node.name), element('small', node.id));
  identity.append(name);
  row.append(identity, td(nodeRoleLabel(node.role)), td(node.public_url), td(`${node.credential_prefix}••••`, 'key-inline'), badge(node.status), td(date(node.last_seen_at)));
  const action = element('td', null, 'actions');
  const next = node.status === 'active' ? 'disabled' : 'active';
  action.append(button(next === 'active' ? '启用' : '停用', async (event) => {
    const trigger = event.currentTarget;
    trigger.disabled = true;
    try {
      await request(`/web/admin/cms/nodes/${encodeURIComponent(node.id)}/status`, { method: 'POST', body: { status: next } });
      notify(next === 'active' ? '节点已启用' : '节点已停用');
      await refresh();
    } catch (error) { notify(error.message, true); }
    finally { if (trigger.isConnected) trigger.disabled = false; }
  }));
  action.append(button('轮换凭证', async (event) => {
    const trigger = event.currentTarget;
    trigger.disabled = true;
    try {
      const result = await request(`/web/admin/cms/nodes/${encodeURIComponent(node.id)}/rotate`, { method: 'POST', body: {} });
      showSecret('新的节点凭证', result.node_credential, `${node.name} 的旧凭证已立即失效。请马上更新该节点环境变量并重启服务。`);
      await refresh();
    } catch (error) { notify(error.message, true); }
    finally { if (trigger.isConnected) trigger.disabled = false; }
  }));
  row.append(action);
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
  const cms = data.cms ?? {};
  const nodes = Array.isArray(cms.nodes) ? cms.nodes : [];
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
  renderRows('license-list', licenses.filter((license) => (!licenseStatus || license.status === licenseStatus) && [license.customer_ref, license.bound_domain, license.key_prefix].some((value) => match(value, licenseQuery))), 7, licenseRow, '没有匹配的授权');
  if ($('migration-count')) $('migration-count').textContent = `${migrations.length} 条记录`;
  if ($('migration-list')) renderRows('migration-list', migrations, 7, migrationRow, '暂无域名迁移申请');
  const list = $('version-list');
  if ($('version-count')) $('version-count').textContent = `${versions.length} 个版本`;
  list.replaceChildren();
  if (!versions.length) {
    const empty = element('div', null, 'empty-state');
    empty.append(element('span', '▦'), element('strong', '尚未发布版本'), element('p', '上传第一个正式主题包后，客户才能创建构建。'));
    list.append(empty);
  }
  for (const version of versions) {
    const item = element('article', null, 'release-item compact-release-item');
    const summary = element('div', null, 'release-summary');
    const title = element('div', null, 'version-name-row');
    title.append(element('strong', version.display_name || `APPGOG ${version.version}`));
    if (version.is_latest) title.append(element('span', '最新', 'badge success'));
    summary.append(title, element('small', `${version.version || '—'} · ${channelLabel(version.channel)} · ${releaseKindLabel(version.release_kind)} · ${date(version.published_at || version.created_at)}`), element('p', version.release_notes || '暂无更新公告'));
    const meta = element('div', null, 'release-meta');
    meta.append(element('span', version.source_kind === 'official' ? '真实源码 ZIP' : version.source_kind || '源码未知'));
    meta.append(element('span', version.rollback_allowed === false ? '禁止回滚' : version.rollback_to ? `可回滚至 ${version.rollback_to}` : '允许回滚'));
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
  const activationQuery = search('activation-search');
  renderRows('activation-list', activations.filter((item) => [item.customer_ref, item.domain, item.backend_origin, item.version].some((value) => match(value, activationQuery))), 7, (item) => { const row = element('tr'); row.append(td(item.customer_ref), td(item.version), td(item.domain), td(item.backend_origin), badge(item.status), td(date(item.last_seen_at)), td(date(item.created_at))); return row; }, '没有匹配的激活站点');
  $('admin-count').textContent = `${admins.length} 位成员`;
  renderRows('admin-list', admins, 6, adminRow, '暂无管理员数据；后端提供 admins 字段后会自动显示');
  const auditQuery = search('audit-search');
  renderRows('audit-list', audit.filter((item) => [item.action, item.actor_type, item.actor_id, item.subject_type, item.subject_id].some((value) => match(value, auditQuery))), 6, (item) => { const row = element('tr'); row.append(td(item.action), td(item.actor_type), td(item.actor_id), td(item.subject_type), td(item.subject_id), td(date(item.created_at))); return row; }, '没有匹配的审计记录');
  const cmsForm = $('cms-settings-form');
  if (cmsForm) {
    for (const key of ['platform_name', 'domain_migration_cooldown_hours']) {
      if (cmsForm.elements[key]) cmsForm.elements[key].value = cms[key] ?? '';
    }
  }
  const announcementForm = $('announcement-form');
  if (announcementForm) {
    announcementForm.elements.title.value = cms.announcement_title ?? '';
    announcementForm.elements.body.value = cms.announcement_body ?? '';
    announcementForm.elements.enabled.checked = cms.announcement_enabled === true;
  }
  if ($('announcement-state')) {
    $('announcement-state').textContent = cms.announcement_enabled ? '已启用' : '未启用';
    $('announcement-state').classList.toggle('status-success', cms.announcement_enabled === true);
  }
  if ($('cms-role-badge')) $('cms-role-badge').textContent = installationRoleLabel(cms.installation_role);
  if ($('cms-license-url')) $('cms-license-url').textContent = cms.license_public_url ?? '—';
  if ($('cms-build-url')) $('cms-build-url').textContent = cms.build_public_url ?? '—';
  if ($('cms-installation-role')) $('cms-installation-role').textContent = installationRoleLabel(cms.installation_role);
  if ($('cms-service-status')) $('cms-service-status').textContent = [
    cms.license_service_enabled !== false ? '授权服务在线' : '授权服务停用',
    cms.build_center_enabled !== false ? '打包中心在线' : '打包中心停用',
    cms.worker_enabled !== false ? 'Worker 在线' : 'Worker 停用',
  ].join(' · ');
  if ($('node-count')) $('node-count').textContent = `${nodes.length} 个节点`;
  if ($('node-list')) renderRows('node-list', nodes, 7, nodeRow, '尚未创建独立节点');
  refreshUpdateStatus();
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

async function refreshUpdateStatus() {
  if (mode !== 'admin' || !$('update-state') || !can('system.manage')) return;
  try {
    const update = await request('/web/admin/system/update');
    $('update-state').textContent = update.available ? ({ idle: '可用', queued: '已排队', running: '更新中', succeeded: '已完成', failed: '失败' }[update.state] || update.state) : '助手离线';
    $('update-state').classList.toggle('status-success', update.available && ['idle', 'succeeded'].includes(update.state));
    $('update-current-version').textContent = update.current_version ? `v${update.current_version}` : '—';
    $('update-latest-version').textContent = update.latest_version ? `v${update.latest_version}` : '尚未检查';
    $('update-message').textContent = update.message || '等待操作';
    $('update-log').textContent = Array.isArray(update.log) ? update.log.slice(-12).join('\n') : update.last_log || '暂无更新日志';
    for (const id of ['check-update', 'install-update', 'repair-current']) $(id).disabled = !update.available || ['queued', 'running'].includes(update.state);
  } catch (error) {
    $('update-state').textContent = '读取失败'; $('update-message').textContent = error.message;
  }
}

function changeDomain(license) {
  dialog('更换授权域名', `订单 ${license.customer_ref}。更换后，旧域名激活在下一次刷新时失效。`, (card, close) => {
    const form = element('form', null, 'form-stack');
    const label = element('label', null, 'field');
    label.append(element('span', '新的授权域名'));
    const input = element('input');
    input.required = true;
    input.value = license.bound_domain ?? '';
    input.placeholder = 'new.example.com';
    label.append(input);
    form.append(label);
    const row = element('div', null, 'dialog-actions');
    row.append(button('取消', close, 'button button-secondary'));
    const confirm = element('button', '确认换绑', 'button button-primary');
    confirm.type = 'submit';
    row.append(confirm);
    form.append(row);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      confirm.disabled = true;
      try {
        await request(`/web/admin/licenses/${license.id}/domain`, { method: 'POST', body: { domain: input.value.trim() } });
        close(); notify('授权域名已更新'); await refresh();
      } catch (error) { notify(error.message, true); }
      finally { confirm.disabled = false; }
    });
    card.append(form);
  });
}
function confirmAction(license, action) {
  const names = { rotate: '轮换固定 Key', active: '恢复授权', suspended: '暂停授权', revoked: '永久撤销授权' };
  const details = { rotate: '旧固定 Key 将立即不能登录和打包；新 Key 只在操作完成时显示。', active: '恢复后客户可以再次登录和构建。', suspended: '客户将无法登录或构建；已有激活下次刷新时不能续期。', revoked: '撤销不可恢复，客户和所有既有激活将失效。' };
  dialog(names[action], `订单 ${license.customer_ref}：${details[action]}`, (card, close) => {
    actions(card, close, `确认${names[action]}`, async () => {
      if (action === 'rotate') {
        const result = await request(`/web/admin/licenses/${license.id}/rotate-key`, { method: 'POST' });
        setTimeout(() => showSecret('新的固定授权 Key', result.license_key, '请安全交给客户。关闭后不再显示明文 Key。'), 230);
      } else {
        await request(`/web/admin/licenses/${license.id}/status`, { method: 'POST', body: { status: action } });
        notify(`${names[action]}成功`);
      }
      await refresh();
    }, action === 'revoked');
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
  for (const id of ['license-search', 'license-status-filter', 'admin-build-search', 'build-status-filter', 'activation-search', 'audit-search']) {
    $(id).addEventListener(id.includes('filter') ? 'change' : 'input', () => { if (state.data) renderAdmin(state.data); });
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
        rollback_allowed: String(fields.get('rollback_allowed') || 'false'),
        rollback_to: String(fields.get('rollback_to') || ''),
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
  $('admin-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const fields = new FormData(form);
      await request('/web/admin/admins', { method: 'POST', body: {
        username: String(fields.get('username') || '').trim(),
        display_name: String(fields.get('display_name') || '').trim(),
        password: String(fields.get('password') || ''),
        role: String(fields.get('role') || ''),
      } });
      form.reset();
      notify('管理员账号已创建');
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
  $('announcement-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
    try {
      const fields = new FormData(form);
      await request('/web/admin/announcement', { method: 'POST', body: {
        title: String(fields.get('title') || '').trim(),
        body: String(fields.get('body') || '').trim(),
        enabled: fields.has('enabled'),
      } });
      notify('客户公告已保存'); await refresh();
    } catch (error) { notify(error.message, true); }
    finally { submit.disabled = false; }
  });
  async function triggerUpdate(action) {
    const labels = { 'check-update': '检查更新', 'install-version': '立即更新', 'repair-current': '修复当前版本' };
    try {
      await request('/web/admin/system/update', { method: 'POST', body: { action } });
      notify(`${labels[action]}任务已提交，服务重启后页面会自动恢复`);
      await refreshUpdateStatus();
    } catch (error) { notify(error.message, true); }
  }
  $('check-update')?.addEventListener('click', () => triggerUpdate('check-update'));
  $('install-update')?.addEventListener('click', () => triggerUpdate('install-version'));
  $('repair-current')?.addEventListener('click', () => triggerUpdate('repair-current'));
  setInterval(() => {
    if (!document.hidden && !$('dashboard-view').hidden && can('system.manage')) refreshUpdateStatus();
  }, 5000);
  $('node-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const fields = new FormData(form);
      const result = await request('/web/admin/cms/nodes', { method: 'POST', body: {
        name: String(fields.get('name') || '').trim(),
        role: String(fields.get('role') || ''),
        public_url: String(fields.get('public_url') || '').trim() || null,
      } });
      form.reset();
      showSecret('节点凭证创建成功', result.node_credential, '凭证只显示这一次。请复制到对应节点的环境变量，然后重启节点服务。');
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
}).catch(() => setView(false));

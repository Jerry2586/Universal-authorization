import { createProductUi } from './products.js';
import { $ } from './core.js';
import { createPlanUi } from './plans.js';
import { button, element, roleLabel } from './ui.js';
import { createTicketUi } from './tickets.js';
import { createLicenseUi } from './licenses.js';
import { createMigrationUi } from './migrations.js';
import { createAnnouncementUi } from './announcements.js';
import { createMembersUi } from './members.js';
import { createOperationsUi } from './operations.js';
import { createAdminDashboard } from './admin-dashboard.js';
import { createAdminReleaseUpload } from './admin-release-upload.js';

export function createAdminPage(shell) {
  const {
    state, can, request, uploadTicketAttachment, notify, refresh, showSecret, selectView,
    dialog, actions, setView,
  } = shell;
  const { renderAdminTickets } = createTicketUi({ state, request, uploadTicketAttachment, notify, refresh, can });
  const licenseUi = createLicenseUi({ state, can, request, notify, refresh, showSecret });
  const { licenseRow } = licenseUi;
  const migrationUi = createMigrationUi({ state, request, notify, showSecret, selectView });
  const announcementUi = createAnnouncementUi({ request, notify, refresh });
  const operationsUi = createOperationsUi({ request, notify, can });
  const membersUi = createMembersUi({
    state, request, notify, refresh, showSecret, openDialog: dialog, appendActions: actions,
  });
  const dashboard = createAdminDashboard(shell, {
    licenseRow, renderLicenseManager: licenseUi.renderLicenseManager,
    membersUi, announcementUi, operationsUi, renderAdminTickets,
  });
  const productsUi = createProductUi(shell);
  const plansUi = createPlanUi(shell);
  const releaseUpload = createAdminReleaseUpload(shell);

  function applySession(session) {
    state.session = session;
    state.permissions = Array.isArray(session.permissions) ? session.permissions : [];
    const sections = {
      products: 'product.view', licenses: 'license.view', plans: 'license.view', versions: 'version.view', builds: 'build.view', tickets: 'ticket.view',
      activations: 'activation.view', members: 'admin.manage', audit: 'audit.view',
      announcements: 'system.manage', migration: 'system.manage', cms: 'system.manage', security: 'system.manage',
    };
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

  function openAccountCenter() {
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
        input.name = name; input.type = 'password'; input.autocomplete = autocomplete;
        input.inputMode = 'numeric'; input.required = true;
        if (name !== 'current_password') { input.minLength = 6; input.maxLength = 6; input.pattern = '[0-9]{6}'; }
        label.append(input); form.append(label);
      }
      const row = element('div', null, 'dialog-actions');
      row.append(button('取消', close, 'button button-secondary'));
      const submit = element('button', '保存新密码', 'button button-primary'); submit.type = 'submit';
      row.append(submit); form.append(row);
      form.addEventListener('submit', async (event) => {
        event.preventDefault(); submit.disabled = true;
        try {
          await request('/web/admin/account/password', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
          close(); setView(false); notify('密码修改成功，请使用新密码重新登录');
        } catch (error) { notify(error.message, true); }
        finally { submit.disabled = false; }
      });
      card.append(form);
    });
  }

  function bindLicenseForm() {
    $('license-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget; const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
      try {
        const fields = new FormData(form);
        const until = fields.get('update_until');
        const result = await request('/web/admin/licenses', { method: 'POST', body: {
          product_code: fields.get('product_code'), customer_ref: fields.get('customer_ref'), domain: fields.get('domain'),
          plan_code: fields.get('plan_code'), update_until: until ? new Date(`${until}T23:59:59Z`).toISOString() : null,
          max_builds_per_day: Number(fields.get('max_builds_per_day')),
          max_builds_total: fields.get('max_builds_total') ? Number(fields.get('max_builds_total')) : null,
          max_activations: Number(fields.get('max_activations')),
        } });
        form.reset();
        showSecret('新的固定授权 Key', result.license_key, '请安全交给客户。Key 已加密保存，仅平台所有者重新验证密码后可以查看。');
        await refresh();
      } catch (error) { notify(error.message, true); }
      finally { submit.disabled = false; }
    });
    $('license-plan')?.addEventListener('change', () => plansUi.applyIssueLimits(true));
  }

  function bindSettingsForm() {
    $('cms-settings-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget; const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
      try {
        const fields = new FormData(form);
        const saved = await request('/web/admin/cms/settings', { method: 'POST', body: {
          platform_name: String(fields.get('platform_name') || '').trim(),
          domain_migration_cooldown_hours: Number(fields.get('domain_migration_cooldown_hours')),
        } });
        notify(`运营设置已保存并同步生效：${saved.platform_name}`); await refresh();
      } catch (error) { notify(error.message, true); }
      finally { submit.disabled = false; }
    });
  }

  async function renderLocalSecurity() {
    if (!can('system.manage')) return;
    const status = $('security-local-state');
    const timestamp = $('security-local-time');
    const list = $('security-local-results');
    if (!status || !list) return;
    try {
      const report = await request('/web/admin/security/local-scan');
      status.dataset.state = report.summary_state || 'unavailable';
      status.textContent = report.state === 'running' ? '本机检查正在执行'
        : report.state === 'idle' ? '等待首次检查'
          : ({ ok: '本机检查完成，固定范围未发现异常', stale: '本机检查结果已过期', warning: '本机检查完成，存在需复核项目', unavailable: '本机检查存在不可用项目', finding: '本机检查发现安全问题' })[report.summary_state] || '本机检查状态未知';
      timestamp.textContent = report.checked_at ? `检查时间：${report.checked_at}${report.stale ? ' · 已过期，等待重新检查' : ''}` : (report.reason || '尚无检查时间');
      list.replaceChildren();
      for (const item of report.checks ?? []) {
        const row = document.createElement('li');
        row.dataset.state = item.state;
        row.textContent = `${item.name} · ${({ ok: '正常', warning: '需复核', finding: '发现问题', unavailable: '不可用', stale: '结果过期' })[item.state] || '未知'} · ${item.detail}`;
        list.append(row);
      }
      if (report.state === 'running') setTimeout(() => void renderLocalSecurity(), 2000);
    } catch (error) {
      status.dataset.state = 'unavailable'; status.textContent = '本机代理不可用'; timestamp.textContent = error.message; list.replaceChildren();
    }
  }

  async function renderSecurity() {
    if (!can('system.manage')) return;
    const set = (id, value) => { const node = $(id); if (node) node.textContent = value; };
    const probe = value => value === 'healthy' ? '可达 · 健康响应' : value === 'unreachable' ? '不可达 · 请检查' : value === 'unhealthy' ? '健康检查失败' : '未知 / 未配置';
    set('security-cloud-state', '正在核对');
    try {
      const data = await request('/web/admin/security/status');
      if (!data.connected) throw new Error(data.reason ?? '云端不可达');
      set('security-cloud-state', '云端已连接');
      set('security-cloud-reason', `验证于 ${data.generated_at ?? '未知时间'}`);
      set('security-identity', '双重身份验证通过');
      set('security-build-probe', probe(data.nodes?.['build-center']?.probe?.state));
      set('security-license-probe', probe(data.nodes?.['license-center']?.probe?.state));
      const hostLabel = host => !host?.fresh ? '未上报 / 检查过期' : ({ ok: '固定范围未发现异常', warning: '配置需复核', finding: '发现异常', unavailable: '检查不可用' })[host.state] || '检查未知';
      set('security-build-host-scan', hostLabel(data.nodes?.['build-center']?.host_scan));
      const host = data.nodes?.['license-center']?.host_scan;
      set('security-host-scan', hostLabel(host));
      const reports = Object.values(data.nodes ?? {});
      const stale = reports.some(item => !item.report_fresh);
      const changed = reports.some(item => item.integrity?.state === 'changed');
      const matched = reports.length > 0 && reports.every(item => item.integrity?.state === 'matched' && item.report_fresh);
      set('security-integrity', changed ? '发现文件偏移' : matched ? '可信摘要匹配' : stale ? '报告过期 / 未上报' : '基线未配置');
      const latest = data.events?.[0];
      set('security-event-title', latest ? `${latest.node}: ${latest.kind}` : '暂无安全事件');
      set('security-event-message', latest ? `发生于 ${latest.at}` : '云端当前没有记录到探测或完整性告警。');
    } catch (error) {
      set('security-cloud-state', '无法验证'); set('security-cloud-reason', error.message);
      set('security-identity', '验证失败 / 未配置'); set('security-build-probe', '未知');
      set('security-license-probe', '未知'); set('security-integrity', '未知'); set('security-host-scan', '未知'); set('security-build-host-scan', '未知');
      set('security-event-title', '云端状态未知'); set('security-event-message', '无法读取独立云端事件。');
    }
  }
  function bind() {
    productsUi.bind();
    plansUi.bind();
    migrationUi.bind();
    membersUi.bind();
    announcementUi.bind();
    operationsUi.bind();
    releaseUpload.bind();
    licenseUi.bind();
    bindLicenseForm();
    bindSettingsForm();
    void renderSecurity(); void renderLocalSecurity();
    $('security-local-run')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await request('/web/admin/security/local-scan', { method: 'POST', body: {} });
        await renderLocalSecurity();
      } catch (error) { notify(error.message, true); }
      finally { button.disabled = false; }
    });
    document.querySelectorAll('[data-security-mode]').forEach((button) => button.addEventListener('click', () => {
      const mode = button.dataset.securityMode;
      document.querySelector('[data-security-topology]')?.setAttribute('data-security-topology', mode);
      document.querySelectorAll('[data-security-mode]').forEach((item) => {
        const active = item === button;
        item.classList.toggle('active', active);
        item.setAttribute('aria-pressed', String(active));
      });
      for (const item of document.querySelectorAll('.security-node:not(.security-node-cloud) .security-node-footer span')) {
        item.textContent = mode === 'combined' ? '同一台业务服务器' : '独立业务服务器';
      }
      const note = $('security-topology-note');
      if (note) note.textContent = mode === 'combined'
        ? '当前展示：打包中心与授权中心部署在同一台干净的 Linux 服务器；安全中心单独部署。'
        : '当前展示：打包、授权、安全中心分别部署在三台服务器。';
    }));
    $('open-account-center')?.addEventListener('click', openAccountCenter);
    $('refresh-admin')?.addEventListener('click', refresh);
    for (const id of [
      'license-search', 'license-plan-filter', 'license-status-filter', 'version-search', 'version-status-filter', 'version-product-filter',
      'admin-build-search', 'build-status-filter', 'admin-ticket-search', 'admin-ticket-status-filter',
      'activation-search', 'audit-search',
    ]) {
      $(id)?.addEventListener(id.includes('filter') ? 'change' : 'input', () => { if (state.data) dashboard.render(state.data); });
    }
  }

  async function afterSession(session) {
    if (session.is_owner) await migrationUi.refresh();
  }

  return Object.freeze({ bind, render(data) {
    const options=$('release-plan-options');
    if(options) {
      const selected=new Set([...options.querySelectorAll('input:checked')].map(input=>input.value));
      options.replaceChildren();
      const plans=(data.license_plans ?? []).filter(plan=>plan.status==='active'&&plan.code!=='legacy');
      for(const plan of plans) {
        const label=element('label',null,'release-plan-choice');const input=element('input');input.type='checkbox';input.name='plan_codes';input.value=plan.code;input.checked=selected.has(plan.code);
        label.append(input,element('span',plan.name));options.append(label);
      }
      if(!plans.length)options.append(element('p','暂无可用套餐，请先创建套餐。','muted'));
    }
    productsUi.render(data.products ?? []); plansUi.render(data.license_plans ?? []); dashboard.render(data); void renderSecurity(); void renderLocalSecurity(); }, applySession, afterSession });
}

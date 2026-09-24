import { $ } from './core.js';
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
  const { licenseRow } = createLicenseUi({ state, can, request, notify, refresh, showSecret });
  const migrationUi = createMigrationUi({ state, request, notify, showSecret, selectView });
  const announcementUi = createAnnouncementUi({ request, notify, refresh });
  const operationsUi = createOperationsUi({ request, notify, can });
  const membersUi = createMembersUi({
    state, request, notify, refresh, showSecret, openDialog: dialog, appendActions: actions,
  });
  const dashboard = createAdminDashboard(shell, {
    licenseRow, membersUi, announcementUi, operationsUi, renderAdminTickets,
  });
  const releaseUpload = createAdminReleaseUpload(shell);

  function applySession(session) {
    state.session = session;
    state.permissions = Array.isArray(session.permissions) ? session.permissions : [];
    const sections = {
      licenses: 'license.view', versions: 'version.view', builds: 'build.view', tickets: 'ticket.view',
      activations: 'activation.view', members: 'admin.manage', audit: 'audit.view',
      announcements: 'system.manage', migration: 'system.manage', cms: 'system.manage',
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
          product_code: 'appgog', customer_ref: fields.get('customer_ref'), domain: fields.get('domain'),
          plan_code: fields.get('plan_code'), update_until: until ? new Date(`${until}T23:59:59Z`).toISOString() : null,
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
        buildLimit.value = '1'; buildLimit.max = '1'; activationLimit.value = '1'; activationLimit.max = '1';
      } else {
        buildLimit.max = '10'; activationLimit.max = '3';
        if (Number(buildLimit.value) < 1) buildLimit.value = '3';
        if (Number(activationLimit.value) < 1) activationLimit.value = '1';
      }
    });
  }

  function bindSettingsForm() {
    $('cms-settings-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget; const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
      try {
        const fields = new FormData(form);
        await request('/web/admin/cms/settings', { method: 'POST', body: {
          platform_name: String(fields.get('platform_name') || '').trim(),
          domain_migration_cooldown_hours: Number(fields.get('domain_migration_cooldown_hours')),
        } });
        notify('运营设置已保存'); await refresh();
      } catch (error) { notify(error.message, true); }
      finally { submit.disabled = false; }
    });
  }

  function bind() {
    migrationUi.bind();
    membersUi.bind();
    announcementUi.bind();
    operationsUi.bind();
    releaseUpload.bind();
    bindLicenseForm();
    bindSettingsForm();
    $('open-account-center')?.addEventListener('click', openAccountCenter);
    $('refresh-admin')?.addEventListener('click', refresh);
    for (const id of [
      'license-search', 'license-status-filter', 'version-search', 'version-status-filter',
      'admin-build-search', 'build-status-filter', 'admin-ticket-search', 'admin-ticket-status-filter',
      'activation-search', 'audit-search',
    ]) {
      $(id)?.addEventListener(id.includes('filter') ? 'change' : 'input', () => { if (state.data) dashboard.render(state.data); });
    }
  }

  async function afterSession(session) {
    if (session.is_owner) await migrationUi.refresh();
  }

  return Object.freeze({ bind, render: dashboard.render, applySession, afterSession });
}

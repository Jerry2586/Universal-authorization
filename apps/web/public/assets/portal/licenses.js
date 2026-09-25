import { badge, button, date, element, td } from './ui.js';
import { appendDialogActions, createDialog } from './dialog.js';
import { $ } from './core.js';

export function createLicenseUi({ state, can, request, notify, refresh, showSecret }) {
  let selectedLicenseId = null;
  let currentLicenses = [];
  const revealedLicenseKeys = new Map();
  const eventLabels = Object.freeze({
    'license.issued': '签发授权',
    'license.key_rotated': '轮换固定 Key',
    'license.key_viewed': '查看固定 Key',
    'license.domain_bound': '首次绑定域名',
    'license.domain_changed': '管理员换绑域名',
    'license.domain_migration_requested': '申请域名迁移',
    'license.domain_migration_approved': '批准域名迁移',
    'license.domain_migration_rejected': '拒绝域名迁移',
    'license.domain_migration_self_service': '客户自助换绑',
    'license.plan_changed': '切换授权套餐',
    'license.build_quota_changed': '调整打包额度',
    'license.active': '恢复授权',
    'license.suspended': '暂停授权',
    'license.revoked': '撤销授权',
    'build.authorized': '授权构建',
  });

  function setEyeIcon(eye, revealed) {
    eye.innerHTML = revealed
      ? '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 10.7a2 2 0 0 0 2.7 2.7M9.9 4.3A10.8 10.8 0 0 1 12 4c5.5 0 9 5 9 5a15.8 15.8 0 0 1-2.2 2.6M6.6 6.6C4.3 8 3 10 3 10s3.5 5 9 5c1 0 2-.2 2.9-.5"/></svg>'
      : '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 12s3.5-5 9-5 9 5 9 5-3.5 5-9 5-9-5-9-5Z"/><circle cx="12" cy="12" r="2.5"/></svg>';
  }

  function eventMetadata(metadata = {}) {
    const values = Object.entries(metadata)
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .slice(0, 8)
      .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
    return values.join(' · ') || '无附加信息';
  }

  async function showLicenseEvents(license) {
    try {
      const result = await request(`/web/admin/licenses/${encodeURIComponent(license.id)}/events`);
      createDialog('授权事件记录', `订单 ${license.customer_ref} 的授权生命周期。安全字段已在服务端过滤。`, (card, close) => {
        const timeline = element('div', null, 'ticket-conversation license-event-timeline');
        for (const item of result.events || []) {
          const event = element('article', null, 'ticket-message');
          const head = element('div', null, 'ticket-message-head');
          head.append(
            element('strong', eventLabels[item.event_type] ?? item.event_type),
            element('time', date(item.created_at)),
          );
          const actor = `${item.actor_type ?? 'system'}${item.actor_id ? ` · ${item.actor_id}` : ''}`;
          const outcome = `${item.result ?? 'success'}${item.reason_code ? ` · ${item.reason_code}` : ''}`;
          event.append(head, element('p', `${actor} · ${outcome}`), element('small', eventMetadata(item.metadata)));
          timeline.append(event);
        }
        if (!timeline.childElementCount) timeline.append(element('div', '暂无授权事件', 'empty-state compact-empty'));
        const actions = element('div', null, 'dialog-actions');
        actions.append(button('关闭', close, 'button button-secondary'));
        card.append(timeline, actions);
      });
    } catch (error) { notify(error.message, true); }
  }

  async function toggleLicenseKey(license, keyText, eye) {
    if (revealedLicenseKeys.has(license.id)) {
      revealedLicenseKeys.delete(license.id);
      keyText.textContent = `${license.key_prefix}••••`;
      keyText.removeAttribute('title');
      keyText.classList.remove('revealed');
      setEyeIcon(eye, false);
      eye.title = '查看完整 Key';
      eye.setAttribute('aria-pressed', 'false');
      return;
    }
    eye.disabled = true;
    try {
      const result = await request(`/web/admin/licenses/${encodeURIComponent(license.id)}/key`, { method: 'POST', body: {} });
      revealedLicenseKeys.set(license.id, result.license_key);
      keyText.textContent = result.license_key;
      keyText.title = result.license_key;
      keyText.classList.add('revealed');
      setEyeIcon(eye, true);
      eye.title = '隐藏完整 Key';
      eye.setAttribute('aria-pressed', 'true');
    } catch (error) { notify(error.message, true); }
    finally { eye.disabled = false; }
  }

  function changeDomain(license) {
    createDialog('更换授权域名', `订单 ${license.customer_ref}。更换后，旧域名激活在下一次刷新时失效。`, (card, close) => {
      const form = element('form', null, 'form-stack');
      const label = element('label', null, 'field');
      label.append(element('span', '新的授权域名'));
      const input = element('input'); input.required = true; input.value = license.bound_domain ?? ''; input.placeholder = 'new.example.com';
      label.append(input); form.append(label);
      const row = element('div', null, 'dialog-actions');
      row.append(button('取消', close, 'button button-secondary'));
      const confirm = element('button', '确认换绑', 'button button-primary'); confirm.type = 'submit'; row.append(confirm); form.append(row);
      form.addEventListener('submit', async (event) => {
        event.preventDefault(); confirm.disabled = true;
        try {
          await request(`/web/admin/licenses/${license.id}/domain`, { method: 'POST', body: { domain: input.value.trim() } });
          close(); notify('授权域名已更新'); await refresh();
        } catch (error) { notify(error.message, true); }
        finally { confirm.disabled = false; }
      });
      card.append(form);
    });
  }

  function changePlan(license) {
    const plans = (state.data?.license_plans ?? []).filter(plan => plan.status === 'active' && plan.code !== 'legacy');
    createDialog('切换授权套餐', '套餐能力由服务端、激活 Token 和产品端共同校验；切换后现有激活立即失效，需要重新激活。', (card, close) => {
      const form = element('form', null, 'form-stack');
      const label = element('label', null, 'field'); label.append(element('span', '目标套餐'));
      const select = element('select');
      for (const plan of plans) {
        const option = element('option', `${plan.name}（${plan.code}）`); option.value = plan.code;
        option.selected = plan.code === license.plan_code; select.append(option);
      }
      label.append(select); form.append(label);
      const summary = element('div', null, 'notice notice-info');
      const renderSummary = () => {
        const plan = plans.find((item) => item.code === select.value);
        if (!plan) { summary.textContent = '未找到套餐配置'; return; }
        const buildLimit = plan.limits?.max_builds_per_day ?? license.max_builds_per_day;
        const activationLimit = plan.limits?.max_activations ?? license.max_activations;
        summary.textContent = `能力：${(plan.capabilities ?? []).join('、') || '无'} · 每日构建 ${buildLimit} 次 · 激活 ${activationLimit} 个环境`;
      };
      select.addEventListener('change', renderSummary); renderSummary(); form.append(summary);
      const row = element('div', null, 'dialog-actions'); row.append(button('取消', close, 'button button-secondary'));
      const submit = element('button', '确认切换', 'button button-primary'); submit.type = 'submit'; row.append(submit); form.append(row);
      form.addEventListener('submit', async (event) => {
        event.preventDefault(); submit.disabled = true;
        try {
          await request(`/web/admin/licenses/${license.id}/plan`, { method: 'POST', body: { plan_code: select.value } });
          close(); notify('授权套餐已更新'); await refresh();
        } catch (error) { notify(error.message, true); }
        finally { submit.disabled = false; }
      });
      card.append(form);
    });
  }

  function confirmAction(license, action) {
    const names = { rotate: '轮换固定 Key', active: '恢复授权', suspended: '暂停授权', revoked: '永久撤销授权' };
    const details = { rotate: '旧固定 Key 将立即不能登录和打包；新 Key 只在操作完成时显示。', active: '恢复后客户可以再次登录和构建。', suspended: '客户将无法登录或构建；已有激活下次刷新时不能续期。', revoked: '撤销不可恢复，客户和所有既有激活将失效。' };
    createDialog(names[action], `订单 ${license.customer_ref}：${details[action]}`, (card, close) => {
      appendDialogActions({ card, close, label: `确认${names[action]}`, danger: action === 'revoked', notify, onConfirm: async () => {
        if (action === 'rotate') {
          const result = await request(`/web/admin/licenses/${license.id}/rotate-key`, { method: 'POST' });
          setTimeout(() => showSecret('新的固定授权 Key', result.license_key, '请安全交给客户。关闭后不再显示明文 Key。'), 230);
        } else {
          await request(`/web/admin/licenses/${license.id}/status`, { method: 'POST', body: { status: action } });
          notify(`${names[action]}成功`);
        }
        await refresh();
      } });
    });
  }

  function deleteLicense(license) {
    createDialog('永久删除授权与全部记录', '此操作会删除 Key、客户会话、构建、激活、工单、附件和授权事件；仅保留不含客户信息的匿名删除凭证。', (card, close) => {
      const form = element('form', null, 'form-stack');
      const confirmLabel = element('label', null, 'field'); confirmLabel.append(element('span', `输入 DELETE ${license.id}`));
      const confirmation = element('input'); confirmation.required = true; confirmation.autocomplete = 'off'; confirmLabel.append(confirmation);
      form.append(confirmLabel);
      const row = element('div', null, 'dialog-actions'); row.append(button('取消', close, 'button button-secondary'));
      const submit = element('button', '永久删除', 'button button-danger'); submit.type = 'submit'; row.append(submit); form.append(row);
      form.addEventListener('submit', async (event) => {
        event.preventDefault(); submit.disabled = true;
        try {
          const result = await request(`/web/admin/licenses/${license.id}`, { method: 'DELETE', body: { confirmation: confirmation.value.trim() } });
          close(); notify(result.cleanup_pending ? `授权已删除，${result.cleanup_pending} 个文件进入补偿清理` : '授权及全部关联数据已永久删除'); await refresh();
        } catch (error) { notify(error.message, true); }
        finally { submit.disabled = false; }
      });
      card.append(form);
    });
  }

  function selectedLicense() {
    return currentLicenses.find((license) => license.id === selectedLicenseId) ?? null;
  }

  function closeLicenseManager() {
    selectedLicenseId = null;
    const panel = $('license-management-panel');
    if (panel) panel.hidden = true;
    document.body.classList.remove('modal-open');
  }

  function selectLicense(license, mode = 'manage') {
    selectedLicenseId = license.id;
    renderLicenseManager(currentLicenses);
    const panel = $('license-management-panel');
    if (panel) {
      panel.dataset.mode = mode;
      panel.hidden = false;
    }
    $('license-manager-title').textContent = mode === 'quota' ? '打包额度' : '管理授权';
    $('close-license-manager')?.setAttribute('aria-label', mode === 'quota' ? '关闭打包额度弹窗' : '关闭管理授权弹窗');
    document.body.classList.add('modal-open');
    $('close-license-manager')?.focus();
  }

  function renderLicenseManager(licenses) {
    currentLicenses = Array.isArray(licenses) ? licenses : [];
    const license = selectedLicense();
    const panel = $('license-management-panel');
    if (!panel) return;
    if (!license) {
      panel.hidden = true;
      document.body.classList.remove('modal-open');
      return;
    }
    selectedLicenseId = license.id;
    $('managed-license-customer').textContent = license.customer_ref || '—';
    $('managed-license-domain').textContent = license.bound_domain || '尚未绑定域名';
    $('managed-license-plan').textContent = license.plan_name || license.plan_code || '—';
    $('managed-license-key').textContent = `${license.key_prefix || '—'}••••`;
    $('managed-license-update').textContent = date(license.update_until);
    $('managed-license-activations').textContent = `${license.active_activation_count ?? 0} / ${license.max_activations ?? 0}`;
    const status = $('managed-license-status');
    status.textContent = { active: '正常', suspended: '已暂停', revoked: '已撤销' }[license.status] ?? license.status;
    status.className = `status-pill ${license.status === 'active' ? 'status-success' : ''}`;
    const form = $('license-quota-form');
    form.elements.max_builds_per_day.value = license.max_builds_per_day ?? 1;
    form.elements.max_builds_total.value = Number.isInteger(license.max_builds_total) ? license.max_builds_total : '';
    form.elements.reason.value = '';
    const used = Number(license.build_count ?? 0);
    $('managed-license-used').textContent = `${used} 次`;
    $('managed-license-remaining').textContent = Number.isInteger(license.max_builds_total)
      ? `${Math.max(0, license.max_builds_total - used)} 次` : '不限';
    $('managed-license-daily-used').textContent = `${license.builds_used_last_24_hours ?? 0} / ${license.max_builds_per_day ?? 0} 次`;
    $('managed-license-toggle').textContent = license.status === 'active' ? '暂停授权' : '恢复授权';
    $('managed-license-toggle').disabled = license.status === 'revoked' || !can('license.manage');
    $('managed-license-revoke').disabled = license.status === 'revoked' || !can('license.manage');
    $('managed-license-delete').hidden = !state.session?.is_owner || !can('license.manage');
    for (const id of ['managed-license-domain-action', 'managed-license-plan-action', 'managed-license-rotate']) {
      $(id).disabled = !can('license.manage') || license.status === 'revoked';
    }
    form.querySelector('[type="submit"]').disabled = !can('license.manage') || license.status === 'revoked';
  }

  function bind() {
    $('close-license-manager')?.addEventListener('click', closeLicenseManager);
    $('license-management-panel')?.addEventListener('mousedown', (event) => {
      if (event.target === event.currentTarget) closeLicenseManager();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !$('license-management-panel')?.hidden) closeLicenseManager();
    });
    $('license-quota-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const license = selectedLicense();
      if (!license) return;
      const form = event.currentTarget;
      const submit = form.querySelector('[type="submit"]');
      const fields = new FormData(form);
      submit.disabled = true;
      try {
        const totalValue = String(fields.get('max_builds_total') ?? '').trim();
        await request(`/web/admin/licenses/${encodeURIComponent(license.id)}/quota`, { method: 'POST', body: {
          max_builds_per_day: Number(fields.get('max_builds_per_day')),
          max_builds_total: totalValue ? Number(totalValue) : null,
          reason: String(fields.get('reason') ?? '').trim(),
        } });
        notify('打包额度已保存并同步到打包中心');
        await refresh();
      } catch (error) { notify(error.message, true); }
      finally { submit.disabled = false; }
    });
    $('managed-license-events')?.addEventListener('click', () => selectedLicense() && showLicenseEvents(selectedLicense()));
    $('managed-license-domain-action')?.addEventListener('click', () => selectedLicense() && changeDomain(selectedLicense()));
    $('managed-license-plan-action')?.addEventListener('click', () => selectedLicense() && changePlan(selectedLicense()));
    $('managed-license-rotate')?.addEventListener('click', () => selectedLicense() && confirmAction(selectedLicense(), 'rotate'));
    $('managed-license-toggle')?.addEventListener('click', () => {
      const license = selectedLicense();
      if (license) confirmAction(license, license.status === 'active' ? 'suspended' : 'active');
    });
    $('managed-license-revoke')?.addEventListener('click', () => selectedLicense() && confirmAction(selectedLicense(), 'revoked'));
    $('managed-license-delete')?.addEventListener('click', () => selectedLicense() && deleteLicense(selectedLicense()));
  }

  function licenseRow(license) {
    const row = element('tr');
    const customer = element('td');
    const customerLine = element('div', null, 'license-customer-line');
    const customerName = element('strong', license.customer_ref);
    customerName.title = license.customer_ref || '';
    customerLine.append(customerName);
    const keyText = element('small', revealedLicenseKeys.get(license.id) ?? `${license.key_prefix}••••`,
      `table-subline license-key-value${revealedLicenseKeys.has(license.id) ? ' revealed' : ''}`);
    if (revealedLicenseKeys.has(license.id)) keyText.title = revealedLicenseKeys.get(license.id);
    customer.append(customerLine, keyText);
    if (state.session?.is_owner && can('license.manage')) {
      const eye = button('', () => toggleLicenseKey(license, keyText, eye), 'license-key-eye');
      setEyeIcon(eye, revealedLicenseKeys.has(license.id));
      eye.title = license.key_recoverable ? (revealedLicenseKeys.has(license.id) ? '隐藏完整 Key' : '查看完整 Key') : '历史 Key 需要先轮换才能查看';
      eye.setAttribute('aria-label', eye.title);
      eye.setAttribute('aria-pressed', revealedLicenseKeys.has(license.id) ? 'true' : 'false');
      eye.disabled = !license.key_recoverable;
      customerLine.append(eye);
    }
    const quota = element('td'); quota.append(
      element('strong', `今日 ${license.builds_used_last_24_hours ?? 0} / ${license.max_builds_per_day ?? 0}`),
      element('small', Number.isInteger(license.max_builds_total)
        ? `剩余 ${Math.max(0, license.max_builds_total - Number(license.build_count ?? 0))} 次` : '总额度不限', 'table-subline'),
    );
    const activations = element('td'); activations.append(
      element('strong', `${license.active_activation_count ?? 0} / ${license.max_activations ?? 0}`),
      element('small', license.active_activation_count ? '环境在线' : '尚未激活', 'table-subline'),
    );
    row.append(customer, td(license.plan_name ?? license.plan_code), td(license.bound_domain || '待客户绑定'), badge(license.status), quota, activations, td(date(license.update_until)));
    const action = element('td', null, 'actions');
    if (can('license.view')) action.append(button('打包额度', () => {
      selectLicense(license, 'quota');
      const quotaForm = document.getElementById('license-quota-form');
      quotaForm?.scrollIntoView({ block: 'center' });
      quotaForm?.elements.max_builds_per_day.focus({ preventScroll: true });
    }));
    if (can('license.manage')) action.append(button('管理', () => selectLicense(license)));
    row.append(action); return row;
  }

  return { bind, licenseRow, renderLicenseManager };
}

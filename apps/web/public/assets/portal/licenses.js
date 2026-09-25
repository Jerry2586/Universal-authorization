import { badge, button, date, element, td } from './ui.js';
import { appendDialogActions, createDialog } from './dialog.js';

export function createLicenseUi({ state, can, request, notify, refresh, showSecret }) {
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
    'license.active': '恢复授权',
    'license.suspended': '暂停授权',
    'license.revoked': '撤销授权',
    'build.authorized': '授权构建',
  });

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

  function revealLicenseKey(license) {
    createDialog('查看完整固定 Key', license.key_recoverable ? '请输入当前管理员密码。完整 Key 显示后不会写入日志。' : '该历史 Key 只保存了不可逆哈希，必须先轮换 Key 才能查看。', (card, close) => {
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
    const plans = state.data?.license_plans ?? [];
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
      const passwordLabel = element('label', null, 'field'); passwordLabel.append(element('span', '当前管理员密码'));
      const password = element('input'); password.type = 'password'; password.autocomplete = 'current-password'; password.required = true; passwordLabel.append(password);
      const confirmLabel = element('label', null, 'field'); confirmLabel.append(element('span', `输入 DELETE ${license.id}`));
      const confirmation = element('input'); confirmation.required = true; confirmation.autocomplete = 'off'; confirmLabel.append(confirmation);
      form.append(passwordLabel, confirmLabel);
      const row = element('div', null, 'dialog-actions'); row.append(button('取消', close, 'button button-secondary'));
      const submit = element('button', '永久删除', 'button button-danger'); submit.type = 'submit'; row.append(submit); form.append(row);
      form.addEventListener('submit', async (event) => {
        event.preventDefault(); submit.disabled = true;
        try {
          const result = await request(`/web/admin/licenses/${license.id}`, { method: 'DELETE', body: { password: password.value, confirmation: confirmation.value.trim() } });
          close(); notify(result.cleanup_pending ? `授权已删除，${result.cleanup_pending} 个文件进入补偿清理` : '授权及全部关联数据已永久删除'); await refresh();
        } catch (error) { notify(error.message, true); }
        finally { submit.disabled = false; }
      });
      card.append(form);
    });
  }

  function licenseRow(license) {
    const row = element('tr');
    const keyCell = element('td'); const keyWrap = element('div', null, 'key-preview');
    keyWrap.append(element('code', `${license.key_prefix}••••`));
    if (can('license.manage') && state.session?.is_owner) {
      const reveal = button('查看', () => revealLicenseKey(license), 'key-reveal-button');
      reveal.title = license.key_recoverable ? '重新验证密码后查看完整 Key' : '历史 Key 需要先轮换才能查看'; keyWrap.append(reveal);
    }
    keyCell.append(keyWrap);
    row.append(td(license.customer_ref), keyCell, td(license.plan_name ?? license.plan_code), td(license.bound_domain), badge(license.status), td(license.build_count), td(license.active_activation_count));
    const action = element('td', null, 'actions');
    if (can('license.view')) action.append(button('事件记录', () => showLicenseEvents(license)));
    if (can('license.manage')) action.append(button('换域名', () => changeDomain(license)), button('切套餐', () => changePlan(license)), button('轮换 Key', () => confirmAction(license, 'rotate')));
    if (can('license.manage') && license.status !== 'revoked') {
      action.append(button(license.status === 'active' ? '暂停' : '恢复', () => confirmAction(license, license.status === 'active' ? 'suspended' : 'active')));
      action.append(button('撤销', () => confirmAction(license, 'revoked')));
    }
    if (can('license.manage') && state.session?.is_owner) action.append(button('永久删除', () => deleteLicense(license), 'mini-button danger-link'));
    row.append(action); return row;
  }

  return { licenseRow };
}

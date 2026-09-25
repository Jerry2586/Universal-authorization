import { $ } from './core.js';
import { badge, button, element, renderRows, td } from './ui.js';

const CAPABILITIES = {
  'settings:read': '查看设置', 'settings:write': '修改设置', 'protected:read': '受保护内容',
  'theme:enable': '启用主题', 'xboard:connect': '连接后台', 'updates:read': '版本通知',
};
export function createPlanUi({ can, request, notify, refresh, dialog }) {
  let plans = [];
  function fillSelect(select, items, first) {
    if (!select) return;
    const previous = select.value;
    select.replaceChildren();
    if (first) { const option = element('option', first); option.value = ''; select.append(option); }
    for (const plan of items) {
      const option = element('option', `${plan.name}${plan.status === 'disabled' ? ' · 已停用' : ''}`);
      option.value = plan.code; select.append(option);
    }
    if ([...select.options].some(o => o.value === previous)) select.value = previous;
    else if (!first && items.some(p => p.code === 'paid')) select.value = 'paid';
  }
  function applyIssueLimits(reset = false) {
    const form = $('license-form');
    const plan = plans.find(p => p.code === $('license-plan')?.value);
    if (!form) return;
    form.querySelector('[type="submit"]').disabled = !plan;
    for (const [name, fallback] of [['max_builds_per_day', 50], ['max_activations', 20]]) {
      const input = form.elements[name];
      const max = plan?.limits?.[name] ?? fallback;
      input.max = String(max);
      if (reset || Number(input.value) > max || Number(input.value) < 1) input.value = String(max);
    }
  }
  function editPlan(plan = null) {
    dialog(plan ? '编辑套餐' : '创建套餐', '仅用于后续签发。保存不会改变已经签发的授权或撤销现有激活。', (card, close) => {
      const form = element('form', null, 'form-stack');
      const field = (name, title, value, type = 'text', attributes = {}) => {
        const label = element('label', null, 'field'); label.append(element('span', title));
        const input = element('input'); Object.assign(input, { name, type, value, required: true }, attributes);
        label.append(input); form.append(label); return input;
      };
      field('name', '套餐名称', plan?.name ?? '', 'text', { maxLength: 60 });
      field('code', '唯一标识（创建后固定）', plan?.code ?? '', 'text', { pattern: '[a-z][a-z0-9_-]{1,39}', maxLength: 40, readOnly: Boolean(plan) });
      const select = (name, title, options, current) => {
        const label = element('label', null, 'field'); label.append(element('span', title));
        const input = element('select'); input.name = name;
        for (const [value, text] of options) { const o = element('option', text); o.value = value; input.append(o); }
        input.value = current; label.append(input); form.append(label);
      };
      select('access_tier', '可用版本范围', [['free', '免费版本'], ['paid', '免费与付费版本']], plan?.access_tier ?? 'free');
      field('max_builds_per_day', '每日打包上限', plan?.limits?.max_builds_per_day ?? 1, 'number', { min: 1, max: 50, step: 1 });
      field('max_activations', '激活环境上限', plan?.limits?.max_activations ?? 1, 'number', { min: 1, max: 20, step: 1 });
      const group = element('fieldset', null, 'plan-capabilities'); group.append(element('legend', '产品能力'));
      for (const [key, text] of Object.entries(CAPABILITIES)) {
        const label = element('label'); const input = element('input'); input.type = 'checkbox'; input.name = 'capabilities'; input.value = key;
        input.checked = (plan?.capabilities ?? ['settings:read', 'protected:read', 'updates:read']).includes(key);
        label.append(input, document.createTextNode(text)); group.append(label);
      }
      form.append(group);
      select('status', '签发状态', [['active', '可签发'], ['disabled', '停用']], plan?.status ?? 'active');
      const row = element('div', null, 'dialog-actions'); row.append(button('取消', close, 'button button-secondary'));
      const submit = element('button', '保存套餐', 'button button-primary'); submit.type = 'submit'; row.append(submit); form.append(row);
      form.addEventListener('submit', async event => {
        event.preventDefault(); submit.disabled = true;
        try {
          const fields = new FormData(form);
          await request(`/web/admin/plans${plan ? `/${encodeURIComponent(plan.code)}` : ''}`, { method: 'POST', body: {
            code: fields.get('code'), name: fields.get('name'), access_tier: fields.get('access_tier'), status: fields.get('status'),
            capabilities: fields.getAll('capabilities'), limits: { max_builds_per_day: Number(fields.get('max_builds_per_day')), max_activations: Number(fields.get('max_activations')) },
          } });
          close(); notify('套餐已保存；已有授权保持原权益'); await refresh();
        } catch (error) { notify(error.message, true); }
        finally { submit.disabled = false; }
      });
      card.append(form);
    });
  }
  function renderRowsOnly() {
    const query = ($('plan-search')?.value ?? '').trim().toLowerCase();
    const status = $('plan-status-filter')?.value;
    const items = plans.filter(p => p.code !== 'legacy' && (!status || p.status === status) && `${p.name} ${p.code}`.toLowerCase().includes(query));
    $('plan-count').textContent = `${items.length} 个套餐`;
    renderRows('plan-list', items, 7, plan => {
      const row = element('tr'); const name = element('td'); name.append(element('strong', plan.name), element('small', plan.code, 'table-subline'));
      row.append(name, td(plan.access_tier === 'paid' ? '免费 + 付费' : '免费'), td(`${plan.limits.max_builds_per_day} 次`), td(`${plan.limits.max_activations} 个`), td(`${plan.capabilities.length} 项`), badge(plan.status));
      const cell = element('td', null, 'actions');
      if (can('license.manage')) cell.append(button('编辑套餐', () => editPlan(plan)));
      else cell.append(element('span', '只读', 'muted'));
      row.append(cell); return row;
    }, '暂无符合条件的套餐');
    $('create-plan').hidden = !can('license.manage');
  }
  return Object.freeze({
    bind() {
      $('create-plan')?.addEventListener('click', () => editPlan());
      $('plan-search')?.addEventListener('input', renderRowsOnly);
      $('plan-status-filter')?.addEventListener('change', renderRowsOnly);
    },
    applyIssueLimits,
    render(next) {
      plans = next;
      fillSelect($('license-plan'), plans.filter(p => p.status === 'active' && p.code !== 'legacy'));
      fillSelect($('license-plan-filter'), plans, '全部套餐');
      applyIssueLimits(); renderRowsOnly();
    },
  });
}

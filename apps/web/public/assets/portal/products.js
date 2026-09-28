import { $ } from './core.js';
import { button, element, renderRows, td } from './ui.js';

export function createProductUi({ can, request, notify, refresh, dialog, actions }) {
  function edit(product = null) {
    dialog(product ? '编辑产品' : '创建产品', '产品标识创建后固定；归档停止新签发和新发布，已有授权及历史记录保留。', (card, close) => {
      const form = element('form', null, 'form-stack');
      for (const [name, title, value] of [['name', '产品名称', product?.name], ['code', '产品标识', product?.code]]) {
        const label = element('label', null, 'field'); label.append(element('span', title));
        const input = element('input'); input.name = name; input.value = value ?? ''; input.required = true;
        input.maxLength = name === 'code' ? 64 : 80;
        if (name === 'code') { input.pattern = '[a-z][a-z0-9-]{0,63}'; input.readOnly = Boolean(product); input.placeholder = '例如 appgog'; }
        label.append(input); form.append(label);
      }
      card.append(form);
      form.addEventListener('submit', event => event.preventDefault());
      actions(card, close, '保存产品', async () => {
        if (!form.reportValidity()) throw new Error('请填写产品名称和有效的产品标识');
        const fields = Object.fromEntries(new FormData(form));
        await request(product ? '/web/admin/products/' + encodeURIComponent(product.code) : '/web/admin/products', {
          method: product ? 'PATCH' : 'POST', body: { ...fields, ...(product ? { status: product.status } : {}) },
        });
        notify('产品已保存'); await refresh();
      });
    });
  }
  function toggle(product) {
    const archive = product.status === 'active';
    dialog(archive ? '归档产品' : '恢复产品', archive
      ? '归档后不能签发新授权或发布新版本。已有 Key、激活、构建和客户数据保留，不会被撤销。'
      : '恢复后可以继续签发授权和发布版本。', (card, close) => {
      actions(card, close, archive ? '确认归档' : '确认恢复', async () => {
        await request('/web/admin/products/' + encodeURIComponent(product.code), {
          method: 'PATCH', body: { name: product.name, status: archive ? 'archived' : 'active' },
        });
        notify(archive ? '产品已归档' : '产品已恢复'); await refresh();
      }, archive);
    });
  }
  function options(id, products, filter = false) {
    const select = $(id); if (!select) return;
    const previous = select.value;
    select.replaceChildren();
    const placeholder = element('option', filter ? '全部产品' : '请选择产品'); placeholder.value = ''; select.append(placeholder);
    for (const product of products.filter(item => filter || item.status === 'active')) {
      const option = element('option', product.name + ' · ' + product.code + (product.status === 'archived' ? '（已归档）' : ''));
      option.value = product.code; select.append(option);
    }
    select.value = [...select.options].some(option => option.value === previous) ? previous : '';
    if (!filter && !previous && !select.value && products.some(product => product.code === 'appgog' && product.status === 'active')) select.value = 'appgog';
  }
  return Object.freeze({
    bind() { $('create-product')?.addEventListener('click', () => edit()); },
    render(products = []) {
      if ($('create-product')) $('create-product').hidden = !can('product.manage');
      if ($('product-count')) $('product-count').textContent = products.length + ' 个产品';
      options('license-product', products); options('version-product', products); options('version-product-filter', products, true);
      renderRows('product-list', products, 6, product => {
        const row = element('tr');
        row.append(td(product.name), td(product.code, 'key-inline'), td(product.status === 'active' ? '启用' : '已归档'), td(product.license_count), td(product.version_count));
        const controls = element('td', null, 'actions');
        if (can('product.manage')) controls.append(button('编辑', () => edit(product)), button(product.status === 'active' ? '归档' : '恢复', () => toggle(product)));
        row.append(controls); return row;
      }, '暂无产品，点击创建产品开始');
    },
  });
}

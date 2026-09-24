import { $, state } from './core.js';
import { badge, button, date, element, nodeRoleLabel, renderRows, roleLabel, td } from './ui.js';

export function createMembersUi({ request, notify, refresh, showSecret, openDialog, appendActions }) {
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
    if (admin.is_owner || admin.role === 'owner') action.append(element('span', '受保护账号', 'table-muted'));
    else if (admin.id === state.session?.id) action.append(element('span', '当前账号', 'table-muted'));
    else {
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
        openDialog('删除管理员账号', `将删除“${admin.display_name || admin.username}”的登录权限，并立即撤销其全部会话。历史审计记录会继续保留。`, (card, close) => {
          appendActions(card, close, '确认删除', async () => {
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

  function render(admins, nodes) {
    $('admin-count').textContent = `${admins.length} 位成员`;
    renderRows('admin-list', admins, 6, adminRow, '暂无管理员数据；后端提供 admins 字段后会自动显示');
    if ($('node-count')) $('node-count').textContent = `${nodes.length} 个节点`;
    if ($('node-list')) renderRows('node-list', nodes, 7, nodeRow, '尚未创建独立节点');
  }

  function bind() {
    $('admin-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        const fields = new FormData(form);
        await request('/web/admin/admins', { method: 'POST', body: {
          username: String(fields.get('username') || '').trim(), display_name: String(fields.get('display_name') || '').trim(),
          password: String(fields.get('password') || ''), role: String(fields.get('role') || ''),
        } });
        form.reset();
        notify('管理员账号已创建');
        await refresh();
      } catch (error) { notify(error.message, true); }
      finally { submit.disabled = false; }
    });
    $('node-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        const fields = new FormData(form);
        const result = await request('/web/admin/cms/nodes', { method: 'POST', body: {
          name: String(fields.get('name') || '').trim(), role: String(fields.get('role') || ''),
          public_url: String(fields.get('public_url') || '').trim() || null,
        } });
        form.reset();
        showSecret('节点凭证创建成功', result.node_credential, '凭证只显示这一次。请复制到对应节点的环境变量，然后重启节点服务。');
        await refresh();
      } catch (error) { notify(error.message, true); }
      finally { submit.disabled = false; }
    });
  }

  return { bind, render };
}

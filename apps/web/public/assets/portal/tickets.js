import { $ } from './core.js';
import {
  date, element, fileSize, match, search, ticketCategoryLabel, ticketPriorityLabel, ticketStatusLabel,
} from './ui.js';

export function createTicketUi({ state, request, uploadTicketAttachment, notify, refresh, can }) {
  function ticketListItem(ticket, selected, onSelect) {
    const item = element('button', null, `ticket-list-item${selected ? ' selected' : ''}`);
    item.type = 'button';
    const top = element('span', null, 'ticket-list-top');
    top.append(element('b', ticket.ticket_number), element('span', ticketStatusLabel(ticket.status), `ticket-status status-${ticket.status}`));
    item.append(
      top,
      element('strong', ticket.subject),
      element('small', `${ticketCategoryLabel(ticket.category)} · ${ticketPriorityLabel(ticket.priority)} · ${date(ticket.updated_at)}`),
    );
    item.addEventListener('click', onSelect);
    return item;
  }

  function ticketConversation(ticket, actor) {
    const wrap = element('div', null, 'ticket-conversation');
    for (const message of ticket.messages || []) {
      const item = element('article', null, `ticket-message ${message.actor_type === actor ? 'mine' : ''} ${message.visibility === 'internal' ? 'internal' : ''}`);
      const head = element('div', null, 'ticket-message-head');
      head.append(element('strong', message.visibility === 'internal' ? `${message.actor_name} · 内部备注` : message.actor_name), element('time', date(message.created_at)));
      item.append(head, element('p', message.body));
      wrap.append(item);
    }
    return wrap;
  }

  function ticketAttachments(ticket, actor) {
    const wrap = element('div', null, 'ticket-attachments');
    for (const attachment of ticket.attachments || []) {
      const internal = actor === 'admin' && attachment.visibility === 'internal';
      const link = element('a', `${attachment.original_name} · ${fileSize(attachment.size_bytes)}${internal ? ' · 内部附件' : ''}`,
        `ticket-attachment${internal ? ' internal' : ''}`);
      link.href = `/web/${actor}/tickets/${encodeURIComponent(ticket.id)}/attachments/${encodeURIComponent(attachment.id)}`;
      link.target = '_blank';
      link.rel = 'noopener';
      if (internal) link.title = '仅管理员可查看和下载';
      wrap.append(link);
    }
    return wrap;
  }

  function renderCustomerTicketDetail(ticket) {
    const target = $('customer-ticket-detail');
    target.replaceChildren();
    if (!ticket) {
      const empty = element('div', null, 'empty-state');
      empty.append(element('span', '↗'), element('strong', '选择一张工单'), element('p', '查看客服回复并继续补充信息。'));
      target.append(empty);
      return;
    }
    const head = element('div', null, 'ticket-detail-head');
    const identity = element('div');
    identity.append(element('span', ticket.ticket_number, 'overline'), element('h3', ticket.subject), element('p', `${ticketCategoryLabel(ticket.category)} · ${ticketPriorityLabel(ticket.priority)}${ticket.build_version ? ` · 构建 ${ticket.build_version}` : ''}`));
    head.append(identity, element('span', ticketStatusLabel(ticket.status), `ticket-status status-${ticket.status}`));
    target.append(head, ticketConversation(ticket, 'customer'), ticketAttachments(ticket, 'customer'));
    if (ticket.status !== 'closed') {
      const form = element('form', null, 'ticket-reply-form');
      const textarea = element('textarea');
      textarea.required = true; textarea.maxLength = 5000; textarea.placeholder = '补充信息或回复客服…';
      const controls = element('div', null, 'ticket-reply-actions');
      const file = element('input'); file.type = 'file'; file.accept = '.png,.jpg,.jpeg,.webp,.txt,.log,.pdf';
      const submit = element('button', '发送回复', 'button button-primary'); submit.type = 'submit';
      controls.append(file, submit); form.append(textarea, controls);
      form.addEventListener('submit', async (event) => {
        event.preventDefault(); submit.disabled = true;
        try {
          await request(`/web/customer/tickets/${encodeURIComponent(ticket.id)}/messages`, { method: 'POST', body: { body: textarea.value } });
          await uploadTicketAttachment(`/web/customer/tickets/${encodeURIComponent(ticket.id)}/attachments`, file.files?.[0]);
          notify('工单回复已发送'); await refresh();
        } catch (error) { notify(error.message, true); }
        finally { submit.disabled = false; }
      });
      const close = element('button', '关闭工单', 'button button-secondary');
      close.type = 'button';
      close.addEventListener('click', async () => {
        const reason = window.prompt('请输入关闭原因', '问题已经解决');
        if (reason === null) return;
        close.disabled = true;
        try {
          await request(`/web/customer/tickets/${encodeURIComponent(ticket.id)}/close`, { method: 'POST', body: { reason } });
          notify('工单已关闭'); await refresh();
        } catch (error) { notify(error.message, true); }
        finally { close.disabled = false; }
      });
      target.append(form, close);
    } else {
      const closed = element('div', null, 'notice-card');
      closed.append(element('span', '✓'), element('div'));
      closed.lastElementChild.append(element('strong', '工单已关闭'), element('p', ticket.close_reason || '该工单已经结束处理。'));
      target.append(closed);
    }
  }

  function renderCustomerTickets(tickets, builds) {
    if (!$('customer-ticket-list')) return;
    $('customer-ticket-count').textContent = `${tickets.length} 张工单`;
    const select = $('ticket-build-select');
    if (select) {
      const current = select.value;
      select.replaceChildren(new Option('不关联构建', ''));
      for (const build of builds) select.append(new Option(`${build.version} · ${ticketStatusLabel(build.status)} · ${String(build.id).slice(-8)}`, build.id));
      if ([...select.options].some((option) => option.value === current)) select.value = current;
    }
    if (!tickets.some((ticket) => ticket.id === state.selectedCustomerTicketId)) state.selectedCustomerTicketId = tickets[0]?.id ?? null;
    const list = $('customer-ticket-list'); list.replaceChildren();
    if (!tickets.length) {
      const empty = element('div', null, 'empty-state compact-empty');
      empty.append(element('span', '✦'), element('strong', '暂无工单'), element('p', '遇到问题时从左侧提交。'));
      list.append(empty);
    } else {
      for (const ticket of tickets) list.append(ticketListItem(ticket, ticket.id === state.selectedCustomerTicketId, () => {
        state.selectedCustomerTicketId = ticket.id;
        renderCustomerTickets(tickets, builds);
      }));
    }
    renderCustomerTicketDetail(tickets.find((ticket) => ticket.id === state.selectedCustomerTicketId));
  }

  function renderAdminTicketDetail(ticket, admins) {
    const target = $('admin-ticket-detail');
    if (!target) return;
    target.replaceChildren();
    if (!ticket) {
      const empty = element('div', null, 'empty-state');
      empty.append(element('span', '↗'), element('strong', '选择一张工单'), element('p', '查看客户、授权、构建上下文并进行回复。'));
      target.append(empty);
      return;
    }
    const head = element('div', null, 'ticket-detail-head');
    const identity = element('div');
    identity.append(element('span', ticket.ticket_number, 'overline'), element('h3', ticket.subject), element('p', `${ticket.customer_ref || '客户'} · Key ${ticket.key_prefix || '—'}•••• · ${ticket.bound_domain || '未绑定域名'}`));
    head.append(identity, element('span', ticketStatusLabel(ticket.status), `ticket-status status-${ticket.status}`));
    const context = element('div', null, 'ticket-context-grid');
    const fields = [
      ['类型', ticketCategoryLabel(ticket.category)], ['关联构建', ticket.build_version || '未关联'],
      ['构建状态', ticket.build_status || '—'], ['更新时间', date(ticket.updated_at)],
    ];
    for (const [label, value] of fields) { const item = element('div'); item.append(element('span', label), element('strong', value)); context.append(item); }
    const controls = element('div', null, 'ticket-admin-controls');
    const status = element('select');
    for (const [value, label] of Object.entries({ pending: '待处理', processing: '处理中', waiting_customer: '等客户', resolved: '已解决', closed: '已关闭' })) status.append(new Option(label, value));
    status.value = ticket.status;
    const priority = element('select');
    for (const [value, label] of Object.entries({ low: '低', normal: '普通', high: '较急', urgent: '紧急' })) priority.append(new Option(label, value));
    priority.value = ticket.priority;
    const assignee = element('select'); assignee.append(new Option('未指派', ''));
    for (const admin of admins.filter((item) => item.status === 'active')) assignee.append(new Option(admin.display_name || admin.username, admin.id));
    assignee.value = ticket.assigned_admin_id || '';
    const save = element('button', ticket.status === 'closed' ? '重新打开工单' : '保存处理状态', 'button button-secondary'); save.type = 'button'; save.disabled = !can('ticket.manage');
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const nextStatus = ticket.status === 'closed' ? 'pending' : status.value;
        let reason = null;
        if (nextStatus === 'closed' || ticket.status === 'closed') {
          reason = window.prompt(ticket.status === 'closed' ? '请输入重新打开原因' : '请输入关闭原因', ticket.status === 'closed' ? '需要继续处理' : '问题已经解决');
          if (reason === null) return;
        }
        await request(`/web/admin/tickets/${encodeURIComponent(ticket.id)}/update`, { method: 'POST', body: {
          status: nextStatus, priority: priority.value, assigned_admin_id: assignee.value || null, close_reason: reason,
        } });
        notify('工单状态已更新'); await refresh();
      } catch (error) { notify(error.message, true); }
      finally { save.disabled = !can('ticket.manage'); }
    });
    controls.append(status, priority, assignee, save);
    if (ticket.status === 'closed') {
      status.disabled = true; priority.disabled = true; assignee.disabled = true;
    }
    target.append(head, context, controls, ticketConversation(ticket, 'admin'), ticketAttachments(ticket, 'admin'));
    if (ticket.status !== 'closed' && can('ticket.manage')) {
      const form = element('form', null, 'ticket-reply-form');
      const textarea = element('textarea'); textarea.required = true; textarea.maxLength = 5000; textarea.placeholder = '回复客户或记录内部处理备注…';
      const actions = element('div', null, 'ticket-reply-actions');
      const visibility = element('select'); visibility.append(new Option('客户可见回复', 'public'), new Option('内部备注', 'internal'));
      const file = element('input'); file.type = 'file'; file.accept = '.png,.jpg,.jpeg,.webp,.txt,.log,.pdf';
      const submit = element('button', '发送', 'button button-primary'); submit.type = 'submit';
      actions.append(visibility, file, submit); form.append(textarea, actions);
      form.addEventListener('submit', async (event) => {
        event.preventDefault(); submit.disabled = true;
        try {
          await request(`/web/admin/tickets/${encodeURIComponent(ticket.id)}/messages`, { method: 'POST', body: { body: textarea.value, visibility: visibility.value } });
          const attachmentUrl = `/web/admin/tickets/${encodeURIComponent(ticket.id)}/attachments`
            + `?visibility=${encodeURIComponent(visibility.value)}`;
          await uploadTicketAttachment(attachmentUrl, file.files?.[0]);
          notify(visibility.value === 'internal' ? '内部备注已保存' : '回复已发送给客户'); await refresh();
        } catch (error) { notify(error.message, true); }
        finally { submit.disabled = false; }
      });
      target.append(form);
    }
  }

  function renderAdminTickets(tickets, admins) {
    if (!$('admin-ticket-list')) return;
    const query = search('admin-ticket-search');
    const status = $('admin-ticket-status-filter')?.value || '';
    const filtered = tickets.filter((ticket) => (!status || ticket.status === status)
      && [ticket.ticket_number, ticket.subject, ticket.customer_ref, ticket.bound_domain, ticket.key_prefix].some((value) => match(value, query)));
    const pending = tickets.filter((ticket) => ['pending', 'processing', 'waiting_customer'].includes(ticket.status)).length;
    $('admin-ticket-count').textContent = `${pending} 个待处理`;
    if (!tickets.some((ticket) => ticket.id === state.selectedAdminTicketId)) state.selectedAdminTicketId = tickets[0]?.id ?? null;
    const list = $('admin-ticket-list'); list.replaceChildren();
    if (!filtered.length) {
      const empty = element('div', null, 'empty-state compact-empty');
      empty.append(element('span', '✦'), element('strong', '没有匹配的工单'), element('p', '调整搜索或状态筛选。'));
      list.append(empty);
    } else {
      for (const ticket of filtered) list.append(ticketListItem(ticket, ticket.id === state.selectedAdminTicketId, () => {
        state.selectedAdminTicketId = ticket.id;
        renderAdminTickets(tickets, admins);
      }));
    }
    renderAdminTicketDetail(tickets.find((ticket) => ticket.id === state.selectedAdminTicketId), admins);
  }

  return { renderCustomerTickets, renderAdminTickets };
}

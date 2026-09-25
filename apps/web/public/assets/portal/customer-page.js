import { $ } from './core.js';
import {
  badge, button, channelLabel, date, element, intentLabel, match, progressCell, releaseKindLabel,
  renderRows, search, td,
} from './ui.js';
import { createTicketUi } from './tickets.js';

export function createCustomerPage(shell) {
  const { state, request, uploadTicketAttachment, notify, refresh, selectView, showSecret, dialog, actions, can } = shell;
  const { renderCustomerTickets } = createTicketUi({
    state, request, uploadTicketAttachment, notify, refresh, can,
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
      await request('/web/customer/builds', {
        method: 'POST', body: { version: version.version, domain: state.data.license.bound_domain, intent },
      });
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
    if (version.is_latest_eligible && !version.is_latest) name.append(element('span', '你的最新版本', 'badge success'));
    if (version.is_current) name.append(element('span', '当前版本', 'badge'));
    name.append(element('span', version.access_tier === 'paid' ? '仅付费授权' : '免费授权可用', `badge ${version.access_tier === 'paid' ? '' : 'success'}`));
    identity.append(name, element('small', `${version.version || '—'} · ${channelLabel(version.channel)} · ${releaseKindLabel(version.release_kind)}`));
    top.append(identity, element('span', version.eligible === false ? (version.eligibility_reason || '当前授权不可用') : '可构建', `status-pill ${version.eligible === false ? '' : 'status-success'}`));
    const notes = element('p', version.release_notes || '本版本暂无更新说明。', 'version-notes');
    const footer = element('div', null, 'version-card-footer');
    const eligible = version.eligible !== false;
    let intent = 'update';
    let label = '构建更新包';
    if (version.is_current) { intent = 'reinstall'; label = '重新构建当前版本'; }
    const allowed = eligible && (version.is_latest_eligible || version.is_current);
    const unavailableLabel = !eligible ? (version.eligibility_reason || '当前授权不可用') : '历史版本仅供查看';
    const action = button(allowed ? label : unavailableLabel, () => createCustomerBuild(version, intent, action), `button ${version.is_current ? 'button-secondary' : 'button-primary'}`);
    action.disabled = !allowed;
    footer.append(element('small', date(version.created_at || version.published_at)), action);
    item.append(top, notes, element('div', null, 'version-meta'), footer);
    return item;
  }

  function render(data) {
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

    const announcement = data.announcement;
    const banner = $('announcement-banner');
    if (banner) {
      banner.hidden = !announcement;
      if (announcement) {
        banner.classList.remove('is-expanded');
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

    if ($('domain-bind-panel')) $('domain-bind-panel').hidden = Boolean(license.bound_domain);
    const migration = data.domain_migration;
    const policy = data.domain_migration_policy ?? {};
    if ($('domain-migration-panel')) $('domain-migration-panel').hidden = !license.bound_domain;
    const migrationForm = $('domain-migration-form');
    if (migrationForm) {
      const coolingDown = Boolean(policy.cooldown_active);
      for (const control of migrationForm.elements) control.disabled = coolingDown;
      const status = $('domain-migration-status');
      if (status) status.textContent = coolingDown
        ? `上次换绑：${migration?.previous_domain ?? '—'} → ${migration?.requested_domain ?? license.bound_domain}；下次可换绑时间：${date(policy.next_allowed_at)}`
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
      versions.filter((version) => version.is_latest || version.is_latest_eligible || version.is_current)
        .forEach((version) => catalog.append(customerVersionCard(version)));
    }
    renderRows('recent-build-list', builds.slice(0, 5), 6, customerRow, '还没有构建任务');
    const query = search('customer-build-search');
    renderRows('build-list', builds.filter((job) => [job.version, job.domain, job.build_id, intentLabel(job.intent)]
      .some((value) => match(value, query))), 6, customerRow, '没有匹配的构建任务');
    renderCustomerTickets(tickets, builds);
  }

  async function showBuild(id) {
    try {
      const job = await request(`/web/customer/builds/${encodeURIComponent(id)}`);
      if (!job.install_key) return notify(`${job.message}（${job.progress}%）`, job.status === 'failed');
      const download = await request(`/web/customer/builds/${encodeURIComponent(id)}/download-ticket`, { method: 'POST' });
      showSecret('本次安装 Key', job.install_key, `Build ID：${job.build_id}。本 Key 只能成功激活一次；下载地址将在 5 分钟后失效。`, download.download_url);
    } catch (error) { notify(error.message, true); }
  }

  function bind() {
    $('refresh-customer')?.addEventListener('click', refresh);
    $('customer-build-search')?.addEventListener('input', () => { if (state.data) render(state.data); });
    $('announcement-toggle')?.addEventListener('click', () => {
      const banner = $('announcement-banner');
      const toggle = $('announcement-toggle');
      const expanded = !banner.classList.contains('is-expanded');
      banner.classList.toggle('is-expanded', expanded);
      toggle.textContent = expanded ? '收起内容' : '查看详情';
      toggle.setAttribute('aria-expanded', String(expanded));
    });
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
        await uploadTicketAttachment(`/web/customer/tickets/${encodeURIComponent(ticket.id)}/attachments`, $('customer-ticket-file')?.files?.[0]);
        state.selectedCustomerTicketId = ticket.id;
        form.reset(); notify('工单已提交'); await refresh(); selectView('tickets');
      } catch (error) { notify(error.message, true); }
      finally { submit.disabled = false; }
    });
    $('domain-bind-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget; const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
      try {
        const fields = new FormData(form);
        await request('/web/customer/domain/bind', { method: 'POST', body: { domain: String(fields.get('domain') || '').trim() } });
        form.reset(); notify('授权域名已完成首次绑定'); await refresh();
      } catch (error) { notify(error.message, true); }
      finally { submit.disabled = false; }
    });
    $('domain-migration-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const form = event.currentTarget; const submit = form.querySelector('[type="submit"]');
      const nextDomain = String(new FormData(form).get('domain') || '').trim();
      dialog('确认立即更换授权域名', `当前域名 ${state.data?.license?.bound_domain ?? '—'} 将立即失效，并切换到 ${nextDomain}。固定 Key 不变，但新域名必须重新输入原 Key 激活。`, (card, close) => {
        actions(card, close, '确认立即换绑', async () => {
          submit.disabled = true;
          try {
            await request('/web/customer/domain-migrations', { method: 'POST', body: { domain: nextDomain } });
            form.reset(); notify('域名换绑已完成；请在新域名重新输入原固定 Key 激活'); await refresh();
          } finally { submit.disabled = false; }
        }, true);
      });
    });
    setInterval(() => {
      if (!document.hidden && !$('dashboard-view').hidden && state.data?.builds?.some((job) => ['queued', 'processing'].includes(job.status))) refresh();
    }, 5000);
  }

  return Object.freeze({ bind, render });
}

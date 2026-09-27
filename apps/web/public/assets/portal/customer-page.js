import { buildQuotaView } from './quota-view.js';
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

  let historyItems = [], historyCursor = null, historyLoaded = false, historyBusy = false, historyEpoch = 0, historyTimer;
  async function loadHistory(reset = false) {
    if (historyBusy && !reset) return;
    const epoch = ++historyEpoch;
    historyBusy = true;
    if (reset) { historyItems = []; historyCursor = null; historyLoaded = false; }
    $('history-more').disabled = true;
    $('history-message').textContent = '正在加载…';
    if (reset) renderRows('build-history-list', [], 6, customerRow, '正在加载历史记录');
    try {
      const params = new URLSearchParams({ limit: '20', query: $('customer-history-search').value.trim() });
      if (historyCursor) params.set('cursor', historyCursor);
      const result = await request('/web/customer/builds?' + params);
      if (epoch !== historyEpoch) return;
      const unique = new Map([...historyItems, ...result.items].map(item => [item.id, item]));
      historyItems = [...unique.values()]; historyCursor = result.next_cursor; historyLoaded = true;
      renderRows('build-history-list', historyItems, 6, customerRow, '暂无匹配的打包记录');
      $('history-count').textContent = '已显示 ' + historyItems.length + ' 条记录';
      $('history-more').hidden = !result.has_more;
      $('history-message').textContent = result.has_more ? '继续加载更早的记录' : historyItems.length ? '已显示全部匹配记录' : '';
    } catch (error) {
      if (epoch === historyEpoch) { $('history-message').textContent = error.message; notify(error.message, true); }
    } finally {
      if (epoch === historyEpoch) { historyBusy = false; $('history-more').disabled = false; }
    }
  }

  function customerRow(job) {
    const row = element('tr');
    const version = element('td');
    version.append(element('strong', job.version || '—'), element('small', intentLabel(job.intent), 'table-subline'));
    const status = badge(job.status);
    if (job.quota_refunded_at) status.append(element('small', '已返还 1 次', 'table-subline'));
    if (job.status === 'succeeded') status.append(element('small', job.activation_label || '未激活', 'table-subline'));
    row.append(version, td(job.domain), status, progressCell(job.progress), td(date(job.created_at)));
    const action = element('td');
    const actionGroup = element('div', null, 'build-row-actions');
    action.append(actionGroup);
    actionGroup.append(button(job.status === 'succeeded' ? (job.can_download ? '下载与激活' : '查看激活详情') : '查看状态', () => showBuild(job.id)));
    if (job.can_void) actionGroup.append(button('作废', () => voidBuild(job.id)));
    row.append(action);
    return row;
  }

  async function createCustomerBuild(version, intent, trigger) {
    if (!state.data?.license?.bound_domain) return notify('当前授权尚未绑定域名', true);
    if (trigger) trigger.disabled = true;
    try {
      const job = await request('/web/customer/builds', {
        method: 'POST', body: { version: version.version, domain: state.data.license.bound_domain, intent, base_version: intent === 'install' ? null : state.data.current_version ?? null },
      });
      notify(job.reused ? '已打开已有任务；请先使用或作废未使用的安装包' : `${intentLabel(intent)}已进入安全构建队列`);
      await refresh();
      selectView('builds');
    } catch (error) { notify(error.message, true); }
    finally { if (trigger?.isConnected) trigger.disabled = false; }
  }

  function customerVersionCard(version) {
    const item = element('article', null, 'customer-version-card version-delivery-card' + (version.is_latest_eligible ? ' latest' : ''));
    const top = element('div', null, 'delivery-card-top');
    const identity = element('div', null, 'delivery-version-heading');
    const title = element('strong', version.display_name || 'APPGOG');
    title.title = version.display_name || 'APPGOG';
    const versionText = element('span', 'v' + (version.version || '—'), 'delivery-version-number');
    if (String(version.display_name || '').includes(version.version)) versionText.hidden = true;
    const labels = element('div', null, 'delivery-version-labels');
    const currentLabel = version.is_current && version.is_latest ? '最新 · 当前版本'
      : version.is_current ? '当前版本' : version.is_latest ? '最新版本'
        : version.is_latest_eligible ? '授权可用最新版' : '';
    if (currentLabel) labels.append(element('span', currentLabel, 'delivery-version-badge' + (version.is_current && !version.is_latest ? ' current' : '')));
    labels.append(element('span', version.access_tier === 'paid' ? '付费授权可用' : '免费授权可用', 'delivery-version-tier'));
    identity.append(title, versionText, labels);
    const eligible = version.eligible !== false;
    const allowed = eligible && (version.is_latest_eligible || version.is_current);
    const availability = element('span', allowed ? '可构建' : '暂不可构建', 'delivery-card-availability');
    top.append(identity, availability);
    const meta = element('small', channelLabel(version.channel) + ' · ' + releaseKindLabel(version.release_kind), 'delivery-version-meta');
    const details = element('details', null, 'version-release-details');
    details.append(element('summary', '更新说明'), element('p', version.release_notes || '本版本暂无更新说明。', 'version-notes'));
    const controls = element('div', null, 'delivery-version-controls');
    const intent = version.is_current ? 'reinstall' : 'update';
    const label = version.is_current ? '重新打包' : '打包此版本';
    const action = button(allowed ? label : '暂不可打包', () => createCustomerBuild(version, intent, action), 'button ' + (version.is_current ? 'button-secondary' : 'button-primary'));
    action.disabled = !allowed;
    controls.append(element('small', date(version.published_at || version.created_at), 'delivery-version-published'), action);
    item.append(top, meta, details);
    if (!allowed) item.append(element('p', !eligible ? version.eligibility_reason || '当前授权不可用' : '历史版本仅供查看', 'delivery-version-reason'));
    item.append(controls);
    return item;
  }

  function render(data) {
    const license = data.license ?? {};
    const versions = Array.isArray(data.versions) ? data.versions : [];
    const builds = Array.isArray(data.builds) ? data.builds : [];
    const tickets = Array.isArray(data.tickets) ? data.tickets : [];
    $('license-status').textContent = license.status === 'active' ? '正常' : license.status;
    $('license-domain').textContent = license.bound_domain ?? '未绑定';
    $('license-domain').title = license.bound_domain ?? '未绑定';
    $('header-domain').textContent = license.bound_domain ?? '未绑定域名';
    const quota = buildQuotaView(license);
    $('license-limit').textContent = quota.available === null ? '待核验' : quota.available + ' 次';
    $('license-quota-note').textContent = quota.reason;
    $('customer-quota-total').textContent = '总额度：' + (quota.unlimited ? '不限' : quota.totalLimit ?? '待核验') + '；累计已用 ' + (quota.totalUsed ?? '—') + ' 次';
    $('customer-quota-daily').textContent = '过去 24 小时：已用 ' + (quota.dailyUsed ?? '—') + ' / ' + (quota.dailyLimit ?? '—') + ' 次，滚动恢复';
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
    if (location.hash === '#history' && !historyLoaded && !historyBusy) loadHistory(true);
  }

  async function voidBuild(id) {
    try {
      const job = await request(`/web/customer/builds/${encodeURIComponent(id)}`);
      if (!job.can_void) return notify('此包正在构建、已经使用或已经失效，不能作废', true);
      dialog('作废未使用的安装包', '作废后安装 Key 和下载入口立即失效，已下载的此包也不能激活。本次实际消耗的打包额度将返还，历史记录保留；排队任务未消耗额度，不重复增加次数。', (card, close) => {
        actions(card, close, '确认作废', async () => {
          await request(`/web/customer/builds/${encodeURIComponent(id)}/void`, { method: 'POST' });
          notify('安装包已作废，实际消耗的额度已返还'); await refresh(); if (historyLoaded) await loadHistory(true);
        }, true);
      });
    } catch (error) { notify(error.message, true); }
  }

  async function showBuild(id) {
    try {
      const job = await request(`/web/customer/builds/${encodeURIComponent(id)}`);
      if (!job.install_key || !job.can_download) {
        dialog(job.status === 'succeeded' ? '安装与激活详情' : '构建详情', (job.status === 'succeeded' ? job.activation_label : job.message) || '等待构建完成', (card, close) => {
          card.append(element('p', '版本：' + job.version + ' · 域名：' + job.domain));
          card.append(element('p', 'Build：' + (job.build_id || '尚未生成')));
          if (job.quota_refunded_at) card.append(element('p', '打包额度已返还 1 次：' + date(job.quota_refunded_at)));
          if (job.install_key_used_at) card.append(element('p', '安装 Key 已使用：' + date(job.install_key_used_at)));
          if (job.activated_at) card.append(element('p', '激活时间：' + date(job.activated_at)));
          if (job.activation_state === 'unlocked') card.append(element('p', '本地解锁已完成，请在主题后台使用固定授权 Key 完成正式激活。'));
          if (job.status === 'failed') card.append(element('p', job.message || '构建失败，请查看日志'));
          card.append(button('关闭', close));
        });
        return;
      }
      const download = await request(`/web/customer/builds/${encodeURIComponent(id)}/download-ticket`, { method: 'POST' });
      showSecret('本次安装 Key', job.install_key, `Build ID：${job.build_id}。本 Key 只能成功激活一次；下载地址将在 5 分钟后失效。`, download.download_url);
    } catch (error) { notify(error.message, true); }
  }

  function bind() {
    document.querySelectorAll('[data-view="history"], [data-go-view="history"]').forEach(node => node.addEventListener('click', () => { if (!historyLoaded) loadHistory(true); }));
    $('refresh-build-history')?.addEventListener('click', () => loadHistory(true));
    $('history-more')?.addEventListener('click', () => loadHistory());
    $('customer-history-search')?.addEventListener('input', () => { clearTimeout(historyTimer); ++historyEpoch; historyBusy = false; historyTimer = setTimeout(() => loadHistory(true), 250); });
    document.addEventListener('appgog-session-cleared', () => {
      ++historyEpoch; clearTimeout(historyTimer); historyItems = []; historyCursor = null; historyLoaded = false; historyBusy = false;
      $('customer-history-search').value = ''; $('build-history-list').replaceChildren();
    });
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
    const ticketDialog = $('customer-ticket-dialog');
    $('open-customer-ticket')?.addEventListener('click', () => ticketDialog.showModal());
    $('cancel-customer-ticket')?.addEventListener('click', () => ticketDialog.close());
    ticketDialog?.addEventListener('cancel', (event) => {
      if ($('customer-ticket-form').querySelector('[type="submit"]').disabled) event.preventDefault();
    });
    $('customer-ticket-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      $('cancel-customer-ticket').disabled = true;
      try {
        const fields = new FormData(form);
        const ticket = await request('/web/customer/tickets', { method: 'POST', body: {
          category: fields.get('category'), priority: fields.get('priority'), build_job_id: fields.get('build_job_id') || null,
          subject: fields.get('subject'), body: fields.get('body'),
        } });
        await uploadTicketAttachment(`/web/customer/tickets/${encodeURIComponent(ticket.id)}/attachments`, $('customer-ticket-file')?.files?.[0]);
        state.selectedCustomerTicketId = ticket.id;
        form.reset(); ticketDialog.close(); notify('工单已提交'); await refresh(); selectView('tickets');
      } catch (error) { notify(error.message, true); }
      finally { submit.disabled = false; $('cancel-customer-ticket').disabled = false; }
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

import { $ } from './core.js';

export function createOperationsUi({ request, notify, can }) {
  function latestLabel(update) {
    if (update.check_status === 'failed') return '发布源不可用';
    if (update.freshness === 'stale') return '检查结果已过期';
    if (update.freshness === 'unchecked') return '尚未检查';
    if (update.relation === 'source_behind') return update.latest_version ? `v${update.latest_version}（发布源落后）` : '发布源落后';
    return update.latest_version ? `v${update.latest_version}` : '尚未检查';
  }

  function statusMessage(update) {
    if (!update.available) return update.message || '宿主机更新助手离线';
    if (update.check_status === 'failed') return update.last_error || '发布源不可用或签名校验失败';
    if (update.freshness === 'stale') return '最近一次检查结果已超过 1 小时，请重新检查';
    if (update.relation === 'source_behind') return '签名发布源版本低于当前运行版本，已禁止更新';
    if (update.relation === 'up_to_date') return '当前已经是最新版本';
    if (update.relation === 'update_available') return `发现签名新版本 v${update.latest_version}`;
    return update.message || '等待操作';
  }

  async function refresh() {
    if (!$('update-state') || !can('system.manage')) return;
    try {
      const update = await request('/web/admin/system/update');
      $('update-state').textContent = update.available
        ? ({ idle: '可用', queued: '已排队', running: '更新中', succeeded: '已完成', failed: '失败' }[update.state] || update.state)
        : '助手离线';
      $('update-state').classList.toggle('status-success', update.available && ['idle', 'succeeded'].includes(update.state));
      $('update-current-version').textContent = update.current_version ? `v${update.current_version}` : '—';
      $('update-latest-version').textContent = latestLabel(update);
      $('update-message').textContent = statusMessage(update);
      if ($('update-checked-at')) $('update-checked-at').textContent = update.checked_at ? new Date(update.checked_at).toLocaleString('zh-CN') : '尚未检查';
      if ($('update-source')) $('update-source').textContent = update.source === 'signed-release' ? '签名 Latest Release' : '—';
      $('update-log').textContent = Array.isArray(update.log) ? update.log.slice(-12).join('\n') : update.last_log || '暂无更新日志';
      if ($('update-fallback')) $('update-fallback').hidden = update.available;
      const busy = ['queued', 'running'].includes(update.state);
      $('check-update').disabled = !update.available || busy;
      $('repair-current').disabled = !update.available || busy;
      $('install-update').disabled = !update.installable;
    } catch (error) {
      $('update-state').textContent = '读取失败';
      $('update-message').textContent = error.message;
      if ($('update-fallback')) $('update-fallback').hidden = false;
    }
  }

  async function trigger(action) {
    const labels = { 'check-update': '检查更新', 'install-version': '安全更新最新版本', 'repair-current': '修复当前版本' };
    try {
      await request('/web/admin/system/update', { method: 'POST', body: { action } });
      notify(action === 'check-update' ? '检查更新任务已提交，请等待检查结果' : `${labels[action]}任务已提交，完成后请核对当前运行版本`);
      await refresh();
    } catch (error) { notify(error.message, true); }
  }

  function bind() {
    $('check-update')?.addEventListener('click', () => trigger('check-update'));
    $('install-update')?.addEventListener('click', () => trigger('install-version'));
    $('repair-current')?.addEventListener('click', () => trigger('repair-current'));
    setInterval(() => {
      if (!document.hidden && !$('dashboard-view').hidden && can('system.manage')) refresh();
    }, 5000);
  }

  return { bind, refresh };
}

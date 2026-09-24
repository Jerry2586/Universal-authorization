import { $ } from './core.js';

export function createOperationsUi({ request, notify, can }) {
  async function refresh() {
    if (!$('update-state') || !can('system.manage')) return;
    try {
      const update = await request('/web/admin/system/update');
      $('update-state').textContent = update.available
        ? ({ idle: '可用', queued: '已排队', running: '更新中', succeeded: '已完成', failed: '失败' }[update.state] || update.state)
        : '助手离线';
      $('update-state').classList.toggle('status-success', update.available && ['idle', 'succeeded'].includes(update.state));
      $('update-current-version').textContent = update.current_version ? `v${update.current_version}` : '—';
      $('update-latest-version').textContent = update.latest_version ? `v${update.latest_version}` : '尚未检查';
      $('update-message').textContent = update.message || '等待操作';
      $('update-log').textContent = Array.isArray(update.log) ? update.log.slice(-12).join('\n') : update.last_log || '暂无更新日志';
      if ($('update-fallback')) $('update-fallback').hidden = update.available;
      for (const id of ['check-update', 'install-update', 'repair-current']) {
        $(id).disabled = !update.available || ['queued', 'running'].includes(update.state);
      }
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
      notify(`${labels[action]}任务已提交，服务重启后页面会自动恢复`);
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

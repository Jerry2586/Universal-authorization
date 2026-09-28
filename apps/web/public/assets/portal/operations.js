import { applySystemVersion } from './system-version.js';
import { createBridgeUpdateUi } from './bridge-updates.js';
import { $ } from './core.js';

export function createOperationsUi({
  request,
  notify,
  can,
  reload = () => location.reload(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  pollInterval = 1000,
  pollTimeout = 15 * 60 * 1000,
  now = () => Date.now(),
}) {
  const bridge = createBridgeUpdateUi({ request, notify, can });
  let versionLocked = false;
  let lockPending = false;
  let activeAction = null;
  let actionPollTimer = null;
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

  async function refresh({ refreshBridge = true } = {}) {
    if (refreshBridge) void bridge.refresh();
    if (!$('update-state') || !can('system.manage')) return;
    try {
      const update = await request('/web/admin/system/update');
      $('update-state').textContent = update.available
        ? ({ idle: '可用', queued: '已排队', running: '更新中', succeeded: '已完成', failed: '失败' }[update.state] || update.state)
        : '助手离线';
      $('update-state').classList.toggle('status-success', update.available && ['idle', 'succeeded'].includes(update.state));
      applySystemVersion(update.current_version);
      if (!update.current_version) $('update-current-version').textContent = '—';
      $('update-latest-version').textContent = latestLabel(update);
      $('update-message').textContent = statusMessage(update);
      if ($('update-checked-at')) $('update-checked-at').textContent = update.checked_at ? new Date(update.checked_at).toLocaleString('zh-CN') : '尚未检查';
      if ($('update-source')) $('update-source').textContent = update.source === 'signed-release' ? '签名 Latest Release' : '—';
      $('update-log').textContent = Array.isArray(update.log) ? update.log.slice(-12).join('\n') : update.last_log || '暂无更新日志';
      if ($('update-fallback')) $('update-fallback').hidden = update.available;
      const busy = ['queued', 'running'].includes(update.state);
      versionLocked = update.version_lock?.locked === true;
      if ($('update-lock-status')) $('update-lock-status').textContent = update.version_lock?.valid === false ? '状态异常，已阻止升级' : versionLocked ? '已锁定 v' + update.version_lock.version : '未锁定';
      if ($('toggle-version-lock')) {
        $('toggle-version-lock').textContent = versionLocked ? '解除版本锁定' : '锁定当前版本';
        $('toggle-version-lock').disabled = busy || lockPending;
      }
      if (versionLocked) $('update-message').textContent = (update.version_lock?.valid === false ? '锁定记录异常，请重新设置。' : '版本已锁定，检查与当前版本修复仍可使用。') + ' ' + statusMessage(update);
      $('check-update').disabled = !update.available || busy;
      $('repair-current').disabled = !update.available || busy;
      $('install-update').disabled = versionLocked || !update.installable;
      return update;
    } catch (error) {
      $('update-state').textContent = activeAction ? '重新连接中' : '读取失败';
      for (const id of ['toggle-version-lock', 'install-update', 'repair-current', 'check-update']) if ($(id)) $(id).disabled = true;
      $('update-message').textContent = activeAction ? '服务正在更新或重启，页面会自动恢复并刷新。' : error.message;
      if ($('update-fallback')) $('update-fallback').hidden = Boolean(activeAction);
      return null;
    }
  }

  function stopActionPoll() {
    if (actionPollTimer !== null) clearTimer(actionPollTimer);
    actionPollTimer = null;
    activeAction = null;
  }

  async function pollAction() {
    if (!activeAction) return;
    const expected = activeAction;
    const update = await refresh({ refreshBridge: false });
    if (!activeAction || activeAction.id !== expected.id) return;
    if (update?.request_id === expected.id) {
      if (['queued', 'running'].includes(update.state)) expected.busySeen = true;
      const terminal = ['succeeded', 'failed'].includes(update.state)
        || (expected.busySeen && update.state === 'idle');
      if (terminal) {
        const succeeded = update.state !== 'failed';
        const action = expected.action;
        stopActionPoll();
        if (!succeeded) return notify(update.last_error || update.message || '在线更新任务执行失败', true);
        if (action === 'check-update') return notify('更新检查已完成，页面状态已同步');
        notify(action === 'repair-current' ? '修复完成，正在自动刷新页面' : '更新完成，正在自动刷新页面');
        setTimer(reload, 250);
        return;
      }
    }
    if (now() - expected.startedAt >= pollTimeout) {
      stopActionPoll();
      notify('任务仍在后台执行，请稍候；页面会继续自动刷新状态', true);
      return;
    }
    actionPollTimer = setTimer(pollAction, pollInterval);
  }

  function startActionPoll(queued) {
    stopActionPoll();
    activeAction = { id: queued.id, action: queued.action, startedAt: now(), busySeen: false };
    void pollAction();
  }

  async function trigger(action) {
    const labels = { 'check-update': '检查更新', 'install-version': '安全更新最新版本', 'repair-current': '修复当前版本' };
    try {
      const queued = await request('/web/admin/system/update', { method: 'POST', body: { action } });
      notify(action === 'check-update' ? '检查更新任务已提交，请等待检查结果' : `${labels[action]}任务已提交，完成后请核对当前运行版本`);
      startActionPoll(queued);
    } catch (error) { notify(error.message, true); }
  }

  function bind() {
    bridge.bind();
    $('toggle-version-lock')?.addEventListener('click', async () => {
      if (lockPending) return;
      lockPending = true; $('toggle-version-lock').disabled = true;
      try {
        await request('/web/admin/system/update/lock', { method: 'POST', body: { locked: !versionLocked } });
        notify(versionLocked ? '版本锁定已解除' : '当前版本已锁定');
      } catch (error) { notify(error.message, true); }
      finally { lockPending = false; await refresh(); }
    });
    $('check-update')?.addEventListener('click', () => trigger('check-update'));
    $('install-update')?.addEventListener('click', () => trigger('install-version'));
    $('repair-current')?.addEventListener('click', () => trigger('repair-current'));
    setInterval(() => {
      if (!document.hidden && !$('dashboard-view').hidden && can('system.manage')) refresh();
    }, 5000);
  }

  return { bind, refresh };
}

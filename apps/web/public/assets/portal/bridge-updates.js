import { $ } from './core.js';

export function createBridgeUpdateUi({ request, notify, can }) {
  const base = '/web/admin/system/bridge';
  let pending = false, reading = false;
  const controls = () => ['bridge-connect', 'bridge-disconnect', 'bridge-check', 'bridge-install', 'bridge-repair'];
  function lock() { for (const id of controls()) if ($(id)) $(id).disabled = true; }
  function render(status) {
    const busy = pending || status.busy;
    $('bridge-state').textContent = busy ? '处理中' : status.connected ? ({ failed: '操作失败', succeeded: '已完成' }[status.state] || '已连接') : '未连接';
    $('bridge-state').classList.toggle('status-success', !busy && status.connected && status.state !== 'failed');
    $('bridge-origin').textContent = status.origin || '尚未连接';
    $('bridge-current').textContent = status.current_version ? `v${status.current_version}` : '待核验';
    $('bridge-latest').textContent = status.latest_version ? `v${status.latest_version}` : '尚未检查或结果已失效';
    $('bridge-checked').textContent = status.checked_at ? new Date(status.checked_at).toLocaleString('zh-CN') : '尚未检查';
    $('bridge-message').textContent = status.message;
    $('bridge-log').textContent = status.log?.length ? status.log.join('\n') : '暂无授权桥操作日志';
    $('bridge-operation').textContent = status.operation_id ? `操作编号：${status.operation_id}` : '';
    $('bridge-connect').disabled = !!busy;
    $('bridge-disconnect').disabled = !!busy || !status.connected;
    $('bridge-check').disabled = !!busy || !status.connected;
    $('bridge-install').disabled = !!busy || !status.installable;
    $('bridge-repair').disabled = !!busy || !status.repairable;
    $('bridge-connect-fields').disabled = !!busy || status.connected;
    $('bridge-connection').open = !status.connected;
    $('bridge-session').textContent = status.connected ? `连接有效至 ${new Date(status.expires_at).toLocaleTimeString('zh-CN')}，断开后可切换站点` : '连接仅在当前管理员会话内有效，最长 20 分钟。';
  }
  async function refresh() {
    if (!$('bridge-state') || !can('system.manage') || reading || pending) return;
    reading = true;
    try { const status = await request(base); if (!pending && can('system.manage')) render(status); }
    catch (error) {
      lock();
      $('bridge-state').textContent = '读取失败';
      $('bridge-message').textContent = error.message;
      $('bridge-current').textContent = '待核验';
      $('bridge-latest').textContent = '检查结果不可用';
    } finally { reading = false; }
  }
  async function send(path, body, label) {
    if (pending) return;
    pending = true; lock();
    $('bridge-state').textContent = '处理中';
    $('bridge-message').textContent = label;
    try { await request(base + path, { method: 'POST', body }); }
    catch (error) { notify(error.message, true); $('bridge-message').textContent = error.message; }
    finally { pending = false; await refresh(); }
  }
  function bind() {
    $('bridge-connect-form')?.addEventListener('submit', event => {
      event.preventDefault();
      const form = event.currentTarget;
      const body = Object.fromEntries(new FormData(form));
      form.elements.password.value = '';
      send('/connect', body, '正在连接并核验实际桥版本…');
    });
    $('bridge-disconnect')?.addEventListener('click', () => send('/disconnect', {}, '正在断开连接…'));
    for (const [id, action] of [['bridge-check', 'check-update'], ['bridge-install', 'install-version'], ['bridge-repair', 'repair-current']]) {
      $(id)?.addEventListener('click', () => send('/update', { action }, '正在提交任务…'));
    }
    // Clear credentials even if the administrator leaves the form without submitting.
    $('logout')?.addEventListener('click', () => $('bridge-connect-form')?.reset());
    document.addEventListener('appgog-session-cleared', () => { $('bridge-connect-form')?.reset(); lock(); });
  }
  return { bind, refresh };
}

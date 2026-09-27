import { $ } from './core.js';

export function createBridgeUpdateUi({ request, notify, can }) {
  const base = '/web/admin/system/bridge';
  let pending = false, reading = false;
  const controls = () => ['bridge-check', 'bridge-install', 'bridge-repair'];
  function lock() { for (const id of controls()) if ($(id)) $(id).disabled = true; }
  function render(status) {
    const busy = pending || status.busy;
    $('bridge-state').textContent = busy ? '处理中' : ({ failed: '操作失败', succeeded: '已完成' }[status.state] || '已就绪');
    $('bridge-state').classList.toggle('status-success', !busy && !!status.current_version && status.state !== 'failed');
    $('bridge-current').textContent = status.current_version ? `v${status.current_version}` : '待核验';
    $('bridge-latest').textContent = status.latest_version ? `v${status.latest_version}` : '尚未检查或结果已失效';
    $('bridge-checked').textContent = status.checked_at ? new Date(status.checked_at).toLocaleString('zh-CN') : '尚未检查';
    $('bridge-message').textContent = status.message;
    $('bridge-log').textContent = status.log?.length ? status.log.join('\n') : '暂无授权桥操作日志';
    $('bridge-operation').textContent = status.operation_id ? `操作编号：${status.operation_id}` : '';
    $('bridge-check').disabled = !!busy;
    $('bridge-install').disabled = !!busy || !status.installable;
    $('bridge-repair').disabled = !!busy || !status.repairable;
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
    for (const [id, action] of [['bridge-check', 'check-update'], ['bridge-install', 'install-version'], ['bridge-repair', 'repair-current']]) {
      $(id)?.addEventListener('click', () => send('/update', { action }, '正在提交任务…'));
    }
    document.addEventListener('appgog-session-cleared', lock);
  }
  return { bind, refresh };
}

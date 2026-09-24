import { $, state } from './core.js';

const stateLabels = Object.freeze({
  waiting_pair: '等待配对', paired: '已配对', import_queued: '等待恢复', preflight: '环境预检',
  source_read_only: '源端只读', uploading: '传输中', target_preflight: '目标预检', restoring: '恢复中',
  target_restoring: '目标恢复中', rollback_required: '正在回滚', completed: '已完成', failed: '失败',
  cancelled: '已取消', rolled_back: '已回滚', expired: '已过期', queued: '已排队', migrating: '迁移中',
});

function text(id, value) { const node = $(id); if (node) node.textContent = value ?? '—'; }
function date(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'; }

export function createMigrationUi({ request, notify, showSecret, selectView }) {
  let timer = null;

  function render(data) {
    const identity = data.identity ?? {};
    const receiver = data.receiver;
    const operation = data.operation;
    text('migration-deployment-id', identity.deployment_id || '—');
    text('migration-generation', identity.ownership_generation ? `第 ${identity.ownership_generation} 代` : '—');
    text('migration-identity-state', stateLabels[identity.status] || identity.status || '—');
    text('migration-receiver-state', receiver ? (stateLabels[receiver.state] || receiver.state) : '未开启');
    text('migration-receiver-expiry', receiver ? date(receiver.expires_at) : '—');
    text('migration-operation-state', operation ? (stateLabels[operation.state] || operation.state) : '等待操作');
    text('migration-operation-message', operation?.message || '先在新服务器开启接收，再回到旧服务器输入目标地址和配对码。');
    const log = $('migration-log');
    if (log) log.textContent = Array.isArray(operation?.log) ? operation.log.slice(-18).join('\n') : '暂无迁移日志';
    const busy = operation && !['completed', 'failed', 'rolled_back', 'cancelled'].includes(operation.state);
    for (const id of ['migration-open-receiver', 'migration-close-receiver', 'migration-source-submit']) {
      if ($(id)) $(id).disabled = Boolean(busy);
    }
    const history = $('migration-history');
    if (history) {
      history.replaceChildren();
      const entries = Array.isArray(data.history) ? data.history : [];
      if (!entries.length) {
        const row = document.createElement('tr'); row.innerHTML = '<td colspan="5" class="empty-cell">暂无迁移记录</td>'; history.append(row);
      } else {
        for (const item of entries) {
          const row = document.createElement('tr');
          for (const value of [item.operation_id, item.direction === 'source' ? '迁出' : '迁入', stateLabels[item.status] || item.status, `第 ${item.ownership_generation} 代`, date(item.updated_at)]) {
            const cell = document.createElement('td'); cell.textContent = value || '—'; row.append(cell);
          }
          history.append(row);
        }
      }
    }
  }

  async function refresh() {
    if (!state.session?.is_owner || !$('migration-operation-state')) return;
    try { render(await request('/web/admin/system/migrations')); }
    catch (error) { text('migration-operation-state', '读取失败'); text('migration-operation-message', error.message); }
  }

  function bind() {
    $('migration-open-receiver')?.addEventListener('click', async (event) => {
      event.currentTarget.disabled = true;
      try {
        const result = await request('/web/admin/system/migrations/receiver', { method: 'POST', body: {} });
        showSecret('新服务器迁移配对码', result.pairing_code,
          `15 分钟内在旧服务器填写目标地址 ${result.target_url} 和此配对码。配对码只显示一次，完成或过期后立即失效。`);
        notify('迁移接收已开启'); await refresh();
      } catch (error) { notify(error.message, true); }
      finally { event.currentTarget.disabled = false; }
    });
    $('migration-close-receiver')?.addEventListener('click', async () => {
      if (!confirm('确认关闭当前迁移接收会话？尚未上传的数据不会被导入。')) return;
      try { await request('/web/admin/system/migrations/receiver/close', { method: 'POST', body: {} }); notify('迁移接收已关闭'); await refresh(); }
      catch (error) { notify(error.message, true); }
    });
    $('migration-source-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const fields = new FormData(form);
      if (!confirm('迁移切换期间旧服务器会短暂停写；目标健康后旧服务器将永久 Fenced。确认开始？')) return;
      const submit = $('migration-source-submit'); submit.disabled = true;
      try {
        const result = await request('/web/admin/system/migrations/source', { method: 'POST', body: {
          target_url: String(fields.get('target_url') || '').trim(),
          pairing_code: String(fields.get('pairing_code') || '').trim().toUpperCase(),
        } });
        notify(`迁移任务已排队：${result.operation_id}`); form.reset(); await refresh(); selectView?.('migration');
      } catch (error) { notify(error.message, true); }
      finally { submit.disabled = false; }
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    timer = setInterval(() => {
      if (!document.hidden && document.querySelector('[data-page="migration"]')?.classList.contains('active')) refresh();
    }, 5000);
  }

  return { bind, refresh, destroy() { if (timer) clearInterval(timer); } };
}

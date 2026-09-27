import { randomUUID } from 'node:crypto';
import { DomainError, invariant } from '../../../../../packages/core/src/errors.js';

const KEY = 'bridge_update_operation';
const CHECK_TTL = 10 * 60 * 1000;
const CONNECTION_TTL = 20 * 60 * 1000;
const compare = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

/** Operations use case. Remote I/O and release verification are injected ports. */
export function createBridgeUpdates({ client, releases, repository, atomic, clock = () => new Date(),
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 20 }) {
  const connections = new Map();
  let busy = false;
  let volatileFailure = null;
  const read = () => {
    if (volatileFailure) return volatileFailure;
    try { return JSON.parse(repository.setting(KEY) || 'null'); } catch { return null; }
  };
  function write(state, actorId) {
    atomic(() => {
      repository.setSetting(KEY, JSON.stringify(state), clock().toISOString());
      repository.audit({ actorType: 'admin', actorId, action: 'bridge_update.' + state.state,
        subjectType: 'bridge_update', subjectId: state.operation_id,
        metadata: { action: state.action, origin: state.origin, version: state.target_version, code: state.error_code || null },
        now: clock().toISOString() });
    });
  }
  const interrupted = read();
  if (interrupted && ['queued', 'running'].includes(interrupted.state)) {
    write({ ...interrupted, state: 'failed', message: '中心进程重启，结果未知；请重新连接并检查运行版本，不会自动重复上传',
      error_code: 'BRIDGE_INTERRUPTED' }, null);
  }
  function connection(session) {
    for (const [id, c] of connections) if (c.expires <= clock().getTime()) connections.delete(id);
    return connections.get(session.id);
  }
  const invalidate = c => { c.checked = null; c.artifact = null; };
  const safeError = error => error instanceof DomainError ? error.message : '授权桥操作失败，请检查站点状态后重试；远端响应未写入日志';

  const api = {
    forget(session) { connections.delete(session.id); },
    status(session) {
      const c = connection(session), state = read();
      const fresh = c?.checked != null && clock().getTime() - c.checked < CHECK_TTL;
      const applicable = !!state && (!c || state.origin === c.remote.origin);
      return {
        connected: !!c, origin: c?.remote.origin || state?.origin || null,
        expires_at: c ? new Date(c.expires).toISOString() : null,
        current_version: c?.current?.version || null,
        latest_version: fresh ? c.artifact?.version || null : null,
        release_version: fresh ? c.artifact?.release_version || null : null,
        checked_at: c?.checked != null ? new Date(c.checked).toISOString() : null,
        installable: !!(!busy && fresh && c.artifact && c.current && compare(c.artifact.version, c.current.version) > 0),
        repairable: !!(!busy && c?.current && compare(c.current.version, '1.1.3') >= 0),
        busy, state: busy ? 'running' : applicable ? state.state : 'idle',
        message: applicable ? state.message : c ? '已连接，请检查更新' : '请连接目标 Xboard 站点',
        operation_id: applicable ? state.operation_id : null, log: applicable ? state.log || [] : [],
      };
    },
    async connect(session, input) {
      invariant(!busy, 'BRIDGE_BUSY', '已有授权桥任务执行中，请稍后连接', 409);
      busy = true;
      // A failed replacement connection must never leave the old target actionable.
      connections.delete(session.id);
      try {
        const remote = await client.connect(input);
        const current = await client.inspect(remote);
        const c = { remote, current, expires: Math.min(clock().getTime() + CONNECTION_TTL, Date.parse(session.expires_at) || Infinity) };
        connections.set(session.id, c);
        setTimeout(() => { if (connections.get(session.id) === c) connections.delete(session.id); }, Math.max(0, c.expires - clock().getTime())).unref();
      } finally { busy = false; }
      return api.status(session);
    },
    disconnect(session) {
      invariant(!busy, 'BRIDGE_BUSY', '任务执行中不能断开连接', 409);
      connections.delete(session.id);
      return api.status(session);
    },
    enqueue(session, action) {
      invariant(['check-update', 'install-version', 'repair-current'].includes(action), 'BRIDGE_ACTION_INVALID', '授权桥操作无效');
      invariant(!busy, 'BRIDGE_BUSY', '已有授权桥任务执行中，请勿重复提交', 409);
      const c = connection(session);
      invariant(c, 'BRIDGE_CONNECT_REQUIRED', '连接已过期，请重新连接 Xboard', 409);
      const status = api.status(session);
      if (action === 'install-version') invariant(status.installable, 'BRIDGE_CHECK_REQUIRED', '请先检查更新，确认有更高版本后再安装', 409);
      if (action === 'repair-current') invariant(status.repairable, 'BRIDGE_REPAIR_UNSUPPORTED', '当前桥不支持在线修复，请先升级到 1.1.3 或更高版本', 409);
      const operation = { operation_id: randomUUID(), action, origin: c.remote.origin, state: 'queued',
        target_version: action === 'repair-current' ? c.current.version : c.artifact?.version || null,
        message: '任务已排队', log: [] };
      write(operation, session.actor_id);
      volatileFailure = null;
      busy = true;
      const record = (message, state = 'running', code = null) => {
        Object.assign(operation, { message, state, error_code: code });
        operation.log.push(clock().toISOString() + ' ' + message);
        operation.log = operation.log.slice(-30);
        write({ ...operation }, session.actor_id);
      };
      // Single process, single writer. Persist intent before I/O. Interrupted or uncertain
      // uploads are never replayed: the next action must inspect the running version first.
      setImmediate(async () => {
        try {
          record('正在检查目标授权桥运行状态');
          const before = await client.inspect(c.remote);
          c.current = before;
          if (action === 'check-update') {
            invalidate(c);
            record('正在验证最新正式发布清单和插件包');
            c.artifact = await releases.latest();
            c.checked = clock().getTime();
            const relation = compare(c.artifact.version, before.version);
            record(relation > 0 ? `可更新到授权桥 ${c.artifact.version}` : relation < 0
              ? '发布源版本低于已安装版本，禁止降级' : '授权桥已是最新版本', 'succeeded');
          } else {
            if (action === 'install-version') {
              record('正在复核签名发布包');
              const artifact = await releases.latest();
              invariant(artifact.version === operation.target_version, 'BRIDGE_RELEASE_CHANGED', '发布版本已变化，请重新检查后再更新', 409);
              invariant(compare(artifact.version, before.version) > 0, 'BRIDGE_NO_UPDATE', '目标已更新或版本更高，未执行上传', 409);
              record('正在通过 Xboard 官方插件接口升级；保留原授权与安装身份');
              await client.upload(c.remote, artifact.buffer, artifact.version);
            } else {
              invariant(compare(before.version, '1.1.3') >= 0, 'BRIDGE_REPAIR_UNSUPPORTED', '目标版本已变化，请重新检查', 409);
              operation.target_version = before.version;
              record('正在修复当前桥的宿主注册及持久脚本，并请求重载');
              const result = await client.repair(c.remote);
              invariant(result.ok === true, 'BRIDGE_REPAIR_FAILED', '目标未确认修复完成', 502);
            }
            // Do not present the pre-update version as a verified running result after a write.
            c.current = null;
            record('正在等待目标返回正确版本和原安装身份');
            let verified = false;
            for (let i = 0; i < attempts; i++) {
              await delay(2000);
              let after;
              try { after = await client.inspect(c.remote); } catch { continue; }
              invariant(after.identity === before.identity, 'BRIDGE_IDENTITY_CHANGED', '安装身份发生变化，更新未通过验收；请检查目标站点', 409);
              if (after.version === operation.target_version) { c.current = after; verified = true; break; }
            }
            invariant(verified, 'BRIDGE_VERIFY_TIMEOUT', '未确认目标运行版本，不能判定成功；请检查 Xboard 日志后重新检查', 504);
            invalidate(c);
            record(`授权桥 ${c.current.version} 健康检查通过，安装身份保持不变`, 'succeeded');
          }
        } catch (error) {
          invalidate(c);
          c.current = null;
          try { record(safeError(error), 'failed', error.code || 'BRIDGE_OPERATION_FAILED'); }
          catch { volatileFailure = { ...operation, state: 'failed', message: '保存操作日志失败，结果未知；请重新连接并检查目标版本', error_code: 'BRIDGE_LOG_FAILED' }; }
        } finally { busy = false; }
      });
      return { operation_id: operation.operation_id, state: 'queued' };
    },
  };
  return api;
}

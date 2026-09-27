import { randomUUID, createHash } from 'node:crypto';
import { DomainError, invariant } from '../../../../../packages/core/src/errors.js';
import { compareBridgeVersion as compare } from '../../../../../packages/core/src/bridge-version.js';
import { signBridgeDelivery } from '../../../../../packages/core/src/bridge-delivery.js';

const KEY = 'bridge_component_operation';
const CHECK_TTL = 10 * 60 * 1000;
const fingerprint = artifact => createHash('sha256').update(artifact.evidence.manifest).digest('hex');
/** Operations owns component maintenance; packaging consumes a read-only snapshot port. */
export function createBridgeUpdates({ distribution, releases, repository, atomic, packagePrivateKey, issuer, clock = () => new Date() }) {
  let busy = false, checked = null, latest = null, volatileFailure = null;
  const read = () => { if (volatileFailure) return volatileFailure; try { return JSON.parse(repository.setting(KEY) || 'null'); } catch { return null; } };
  function write(state, actorId) {
    atomic(() => {
      repository.setSetting(KEY, JSON.stringify(state), clock().toISOString());
      repository.audit({ actorType: 'admin', actorId, action: 'bridge_component.' + state.state,
        subjectType: 'bridge_component', subjectId: state.operation_id,
        metadata: { action: state.action, version: state.target_version, code: state.error_code || null }, now: clock().toISOString() });
    });
  }
  const interrupted = read();
  if (interrupted && ['queued', 'running'].includes(interrupted.state)) write({ ...interrupted, state: 'failed',
    message: '中心进程重启，任务已中断；请重新检查组件版本，不会自动重复更新', error_code: 'BRIDGE_INTERRUPTED' }, null);
  const safeError = error => error instanceof DomainError ? error.message : '授权桥组件操作失败，请重试或查看服务日志';
  const api = {
    snapshot: () => distribution.snapshot(),
    delivery: (snapshot, build) => signBridgeDelivery(snapshot, build.buildId, build.licenseServer || issuer, packagePrivateKey, clock().getTime()),
    status() {
      let current = null, selected = null, error = null;
      try { selected = distribution.selection(); current = distribution.snapshot(); } catch (e) { error = safeError(e); }
      const state = read(), fresh = checked !== null && clock().getTime() - checked < CHECK_TTL;
      return {
        current_version: current?.version || null, selected_version: selected?.version || null,
        latest_version: fresh ? latest?.version || null : null,
        release_version: current?.release_version || null,
        checked_at: checked === null ? null : new Date(checked).toISOString(),
        installable: !!(!busy && fresh && latest && current && compare(latest.version, current.version) > 0),
        repairable: !busy && !!selected,
        busy, state: busy ? 'running' : error ? 'failed' : state?.state || 'idle',
        message: error || state?.message || '组件已就绪，可检查 GitHub 正式版本',
        operation_id: state?.operation_id || null, log: state?.log || [],
      };
    },
    enqueue(session, action) {
      invariant(['check-update', 'install-version', 'repair-current'].includes(action), 'BRIDGE_ACTION_INVALID', '授权桥操作无效');
      invariant(!busy, 'BRIDGE_BUSY', '已有授权桥任务执行中，请勿重复提交', 409);
      const status = api.status();
      if (action === 'install-version') invariant(status.installable, 'BRIDGE_CHECK_REQUIRED', '请先检查版本，确认有更新后再安装', 409);
      if (action === 'repair-current') invariant(status.repairable, 'BRIDGE_REPAIR_UNAVAILABLE', '无法确认当前组件版本，请检查组件索引', 409);
      const selected = distribution.selection();
      const operation = { operation_id: randomUUID(), action, state: 'queued', target_version: action === 'repair-current' ? selected.version : latest?.version || null,
        target_release: action === 'repair-current' ? selected.release_version : latest?.release_version || null,
        target_fingerprint: action === 'install-version' ? fingerprint(latest) : null,
        message: '任务已排队', log: [] };
      write(operation, session.actor_id); volatileFailure = null; busy = true;
      const record = (message, state = 'running', code = null) => {
        Object.assign(operation, { message, state, error_code: code });
        operation.log.push(clock().toISOString() + ' ' + message); operation.log = operation.log.slice(-30);
        write({ ...operation }, session.actor_id);
      };
      setImmediate(async () => {
        try {
          checked = null; latest = null;
          if (action === 'check-update') {
            record('正在检查固定 GitHub 发布源并验证签名');
            const artifact = await releases.latest();
            const relation = compare(artifact.version, selected.version);
            latest = artifact; checked = clock().getTime();
            record(relation > 0 ? `可更新到授权桥 ${artifact.version}` : relation < 0 ? '发布源版本低于当前组件，禁止降级' : '授权桥组件已是最新版本', 'succeeded');
          } else {
            record(action === 'repair-current' ? `正在重新下载当前桥 ${selected.version} 的签名发布包` : '正在复核最新签名发布包');
            const artifact = action === 'repair-current' ? await releases.byVersion(selected.release_version) : await releases.latest();
            invariant(artifact.version === operation.target_version && artifact.release_version === operation.target_release
              && (action !== 'install-version' || fingerprint(artifact) === operation.target_fingerprint), 'BRIDGE_RELEASE_CHANGED', '发布版本已变化，请重新检查', 409);
            record('签名与摘要通过，正在原子替换打包组件');
            const installed = distribution.install(artifact, { repair: action === 'repair-current' });
            invariant(installed.version === operation.target_version, 'BRIDGE_VERIFY_FAILED', '组件版本验收失败', 503);
            record(`授权桥 ${installed.version} 已${action === 'repair-current' ? '修复' : '更新'}，后续打包使用此组件`, 'succeeded');
          }
        } catch (error) {
          checked = null; latest = null;
          try { record(safeError(error), 'failed', error.code || 'BRIDGE_OPERATION_FAILED'); }
          catch { volatileFailure = { ...operation, state: 'failed', message: '操作日志保存失败，请重新检查当前组件', error_code: 'BRIDGE_LOG_FAILED' }; }
        } finally { busy = false; }
      });
      return { operation_id: operation.operation_id, state: 'queued' };
    },
  };
  return api;
}

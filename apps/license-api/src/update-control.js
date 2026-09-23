import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { newId } from '../../../packages/core/src/identifiers.js';
import { invariant } from '../../../packages/core/src/errors.js';

const ACTIONS = new Set(['check-update', 'install-version', 'repair-current']);
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function readJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function createUpdateControl({ root, currentVersion, clock = () => new Date() }) {
  root ??= resolve(process.cwd(), 'var/update-control');
  const requests = join(root, 'requests');
  const statusPath = join(root, 'status.json');
  mkdirSync(requests, { recursive: true });

  return {
    status() {
      const status = readJson(statusPath);
      if (!status) return { available: false, state: 'unavailable', current_version: currentVersion, message: '宿主机更新助手尚未连接' };
      const heartbeat = new Date(status.heartbeat_at ?? status.updated_at ?? 0);
      const available = Number.isFinite(heartbeat.getTime()) && clock().getTime() - heartbeat.getTime() < 90_000;
      return { ...status, available, current_version: currentVersion };
    },

    enqueue(action, version = null) {
      invariant(ACTIONS.has(action), 'UPDATE_ACTION_INVALID', '在线更新动作无效');
      const normalizedVersion = version ? String(version).trim().replace(/^v/, '') : null;
      invariant(!normalizedVersion || VERSION_PATTERN.test(normalizedVersion), 'UPDATE_VERSION_INVALID', '目标版本号格式无效');
      const status = this.status();
      invariant(status.available, 'UPDATE_HELPER_UNAVAILABLE', '宿主机更新助手未运行，请先执行 appgog repair-source 修复助手', 503);
      invariant(!['queued', 'running'].includes(status.state), 'UPDATE_ALREADY_RUNNING', '已有更新任务正在执行', 409);
      const request = { id: newId('upd'), action, version: normalizedVersion, requested_at: clock().toISOString() };
      atomicJson(join(requests, `${request.id}.json`), request);
      atomicJson(statusPath, {
        ...status,
        state: 'queued',
        message: '更新请求已排队',
        requested_action: action,
        target_version: normalizedVersion,
        updated_at: request.requested_at,
      });
      return request;
    },
  };
}

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { newId } from '../../../packages/core/src/identifiers.js';
import { invariant } from '../../../packages/core/src/errors.js';

const ACTIONS = new Set(['check-update', 'install-version', 'repair-current']);
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const RELEASE_RESULT_TTL_MS = 60 * 60 * 1000;

function compareVersions(left, right) {
  const parse = (value) => {
    const [core, prerelease = ''] = String(value ?? '').split(/[+-]/, 2);
    const numbers = core.split('.').map(Number);
    if (numbers.length !== 3 || numbers.some((part) => !Number.isInteger(part))) return null;
    return { numbers, prerelease };
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, 'en', { numeric: true });
}

function releaseState(status, currentVersion, now) {
  const schema = Number(status.schema ?? 1);
  const checkStatus = schema >= 2 ? status.check_status ?? 'unchecked' : 'unchecked';
  const checkedAt = new Date(schema >= 2 ? status.checked_at ?? 0 : 0);
  const checkedAtValid = Number.isFinite(checkedAt.getTime());
  const freshness = checkStatus === 'failed'
    ? 'failed'
    : checkStatus !== 'succeeded' || !checkedAtValid
      ? 'unchecked'
      : now.getTime() - checkedAt.getTime() <= RELEASE_RESULT_TTL_MS ? 'fresh' : 'stale';
  let relation = 'unknown';
  if (freshness === 'fresh' && status.latest_version) {
    const comparison = compareVersions(status.latest_version, currentVersion);
    if (comparison > 0) relation = 'update_available';
    else if (comparison === 0) relation = 'up_to_date';
    else if (comparison < 0) relation = 'source_behind';
  }
  return { check_status: checkStatus, freshness, relation };
}

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
      if (!status) return {
        schema: 2,
        available: false,
        installable: false,
        state: 'unavailable',
        current_version: currentVersion,
        check_status: 'unchecked',
        freshness: 'unchecked',
        relation: 'unknown',
        message: '宿主机更新助手尚未连接',
      };
      const heartbeat = new Date(status.heartbeat_at ?? status.updated_at ?? 0);
      const available = Number.isFinite(heartbeat.getTime()) && clock().getTime() - heartbeat.getTime() < 90_000;
      const release = releaseState(status, currentVersion, clock());
      const busy = ['queued', 'running'].includes(status.state);
      const installable = available && !busy && release.check_status === 'succeeded'
        && release.freshness === 'fresh' && release.relation === 'update_available';
      return { ...status, ...release, available, installable, current_version: currentVersion };
    },

    enqueue(action, version = null) {
      invariant(ACTIONS.has(action), 'UPDATE_ACTION_INVALID', '在线更新动作无效');
      const normalizedVersion = version ? String(version).trim().replace(/^v/, '') : null;
      invariant(!normalizedVersion || VERSION_PATTERN.test(normalizedVersion), 'UPDATE_VERSION_INVALID', '目标版本号格式无效');
      const status = this.status();
      invariant(status.available, 'UPDATE_HELPER_UNAVAILABLE', '宿主机更新助手未运行，请先执行 appgog repair-source 修复助手', 503);
      invariant(!['queued', 'running'].includes(status.state), 'UPDATE_ALREADY_RUNNING', '已有更新任务正在执行', 409);
      if (action === 'install-version') {
        invariant(status.freshness !== 'stale', 'UPDATE_CHECK_STALE', '更新检查结果已过期，请重新检查更新', 409);
        invariant(status.relation !== 'source_behind', 'UPDATE_SOURCE_BEHIND', '签名发布源版本落后于当前运行版本，已禁止更新', 409);
        invariant(status.check_status === 'succeeded' && status.freshness === 'fresh', 'UPDATE_RELEASE_NOT_READY', '尚未取得新鲜有效的签名发布结果，请先检查更新', 409);
        invariant(status.relation === 'update_available', 'UPDATE_NO_UPDATE', '当前已经是最新版本，无需重复更新', 409);
      }
      const request = { id: newId('upd'), action, version: normalizedVersion, requested_at: clock().toISOString() };
      atomicJson(join(requests, `${request.id}.json`), request);
      const { available: _available, installable: _installable, freshness: _freshness, relation: _relation, ...persisted } = status;
      atomicJson(statusPath, {
        ...persisted,
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

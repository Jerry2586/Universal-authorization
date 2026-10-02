import { request as unixRequest } from 'node:http';

export const LOCAL_SECURITY_STALE_AFTER_MS = 15 * 60 * 1000;

export const LOCAL_SECURITY_REQUIRED_CHECKS = Object.freeze([
  '核心文件完整性', '程序目录完整性', '业务环境配置', '业务容器运行配置',
  '监听端口变化', 'SSH 生效配置', '本机备份', 'Linux 系统', 'systemd 状态',
  'SSH 基础配置', '安装目录权限', '定时任务权限', '监听端口', '病毒特征查杀',
]);

const CHECK_STATE_PRIORITY = Object.freeze({ ok: 0, stale: 1, warning: 2, unavailable: 3, finding: 4 });

function summarizeLocalSecurityState(state, checks, stale) {
  if (state === 'failed' || state === 'unavailable') return 'unavailable';
  if (state === 'idle' || state === 'running') return 'warning';
  return checks.reduce((summary, check) => CHECK_STATE_PRIORITY[check.state] > CHECK_STATE_PRIORITY[summary]
    ? check.state : summary, stale ? 'stale' : 'ok');
}

export function normalizeLocalSecurityReport(result, statusCode, now = Date.now()) {
  if (![200, 202, 409, 429].includes(statusCode)
      || !result || typeof result !== 'object'
      || !['idle', 'running', 'finished', 'failed', 'unavailable'].includes(result.state)) {
    return { state: 'unavailable', reason: '本机检查代理返回异常' };
  }
  const checkedAt = typeof result.checked_at === 'string' ? result.checked_at.slice(0, 64) : null;
  const checkedTime = checkedAt ? Date.parse(checkedAt) : Number.NaN;
  const stale = result.state === 'finished'
    && (!Number.isFinite(checkedTime) || now - checkedTime > LOCAL_SECURITY_STALE_AFTER_MS || checkedTime - now > 5 * 60 * 1000);
  const checks = Array.isArray(result.checks) ? result.checks.slice(0, 20)
    .filter(item => item && typeof item.name === 'string' && typeof item.detail === 'string'
      && ['ok', 'warning', 'finding', 'unavailable', 'stale'].includes(item.state))
    .map(item => ({ name: item.name.slice(0, 60),
      state: stale && item.state === 'ok' ? 'stale' : item.state,
      detail: item.detail.slice(0, 180) })) : [];
  const checkNames = new Set(checks.map(item => item.name));
  const complete = result.state !== 'finished' || (checks.length === LOCAL_SECURITY_REQUIRED_CHECKS.length
    && checkNames.size === checks.length
    && LOCAL_SECURITY_REQUIRED_CHECKS.every(name => checkNames.has(name)));
  const completenessCheck = { name: '检查报告完整性', state: 'unavailable',
    detail: '本机代理报告缺项、重复或包含未识别项目，不能据此断言服务器安全' };
  const visibleChecks = !complete && checks.length < 20 ? [...checks, completenessCheck] : checks;
  const summaryChecks = complete ? checks : [...checks, completenessCheck];
  return { state: result.state, summary_state: summarizeLocalSecurityState(result.state, summaryChecks, stale),
    checked_at: checkedAt, stale,
    reason: !complete ? '本机检查报告不完整，不能继续作为健康依据'
      : stale ? '本机检查结果已过期，不能继续作为健康依据'
      : result.state === 'unavailable' ? '本机检查频率限制或代理异常' : undefined,
    checks: visibleChecks };
}

// One fixed local action. The browser never chooses a command or path.
export function localSecurityScan(action, env = process.env) {
  if (!['status', 'scan'].includes(action)) throw new TypeError('Unknown security action');
  const socketPath = env.APPGOG_HOST_SCAN_SOCKET || '/app/runtime/host-security/scan.sock';
  return new Promise((resolve) => {
    const req = unixRequest({ socketPath, path: action === 'scan' ? '/scan' : '/status',
      method: action === 'scan' ? 'POST' : 'GET', timeout: 5000,
      headers: action === 'scan' ? { 'Content-Length': '0' } : {} }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (body.length > 16384) req.destroy(new Error('oversized response'));
      });
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          resolve(normalizeLocalSecurityReport(result, res.statusCode));
        } catch {
          resolve({ state: 'unavailable', reason: '本机检查代理响应无效' });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ state: 'unavailable', reason: '本机检查代理未接入或超时' }));
    req.end();
  });
}

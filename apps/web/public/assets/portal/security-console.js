// View-only controller; authorization and report validation remain in security-ui.
const GROUPS = Object.freeze({
  malware: ['malware.program', 'malware.business'],
  environment: ['host.os-release', 'host.systemd-state', 'ssh.effective', 'permissions.secret-inventory', 'permissions.installation', 'permissions.cron', 'network.listeners', 'network.udp-listeners', 'network.routes', 'host.kernel-security', 'network.firewall', 'host.process-executables', 'host.failed-units', 'cloudflare.dns', 'cloudflare.workers', 'cloudflare.rules', 'cloudflare.settings'],
  containers: ['integrity.program', 'host.configuration', 'container.contract', 'container.approved-image', 'database.sqlite'],
  realtime: ['response.containment', 'host.systemd-state', 'integrity.program', 'host.configuration'],
  recovery: ['response.containment', 'container.approved-image'],
});
const LABELS = { ok: '正常', warning: '需复核', finding: '发现问题', unavailable: '不可用' };
export function createSecurityConsole() {
  const scope = document.querySelector('.security-console');
  const set = (selector, value) => scope?.querySelectorAll(selector).forEach(node => { node.textContent = value; });
  let bound = false;
  function open(name, focus = false) {
    const tab = scope?.querySelector('[data-security-tab="' + name + '"]');
    if (!tab) return;
    scope.querySelectorAll('[data-security-tab]').forEach(node => {
      const selected = node === tab;
      node.classList.toggle('active', selected);
      node.setAttribute('aria-selected', String(selected));
      node.tabIndex = selected ? 0 : -1;
    });
    scope.querySelectorAll('[data-security-panel]').forEach(node => { node.hidden = node.dataset.securityPanel !== name; });
    if (focus) tab.focus();
  }
  function bind() {
    if (!scope || bound) return;
    bound = true;
    scope.querySelectorAll('[data-security-tab], [data-security-open]').forEach(button => {
      button.addEventListener('click', () => open(button.dataset.securityTab || button.dataset.securityOpen, Boolean(button.dataset.securityOpen)));
    });
    const tabs = [...scope.querySelectorAll('[data-security-tab]')];
    tabs.forEach((tab, index) => tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next === undefined) return;
      event.preventDefault(); open(tabs[next].dataset.securityTab, true);
    }));
  }
  function setBusy(busy) {
    if (!scope) return;
    scope.dataset.scRunning = String(busy);
    scope.querySelectorAll('[data-security-scan]').forEach(button => { button.disabled = busy; });
  }
  function update(report, { trusted = false, busy = false, issue = '等待有效报告' } = {}) {
    const checks = Array.isArray(report?.checks) ? report.checks : [];
    const running = report?.state === 'running';
    setBusy(running || busy);
    set('[data-security-stat="coverage"]', trusted ? checks.filter(item => item.id !== 'host.history').length + ' / 25' : '—');
    set('[data-security-stat="findings"]', trusted ? String(checks.filter(item => item.state === 'finding').length) : '—');
    set('[data-security-stat="attention"]', trusted ? String(checks.filter(item => ['warning', 'unavailable'].includes(item.state)).length) : '—');
    set('[data-security-stat="time"]', trusted ? new Date(report.checked_at).toLocaleTimeString('zh-CN', { hour12: false }) : '尚无有效报告');
    set('[data-security-stat="freshness"]', trusted ? '最近十五分钟内' : issue);
    for (const [group, ids] of Object.entries(GROUPS)) {
      const items = checks.filter(item => ids.includes(item.id));
      const groupState = !trusted ? 'unavailable' : items.some(item => item.state === 'finding') ? 'finding' : items.some(item => item.state !== 'ok') ? 'warning' : 'ok';
      const label = !trusted ? issue : groupState === 'ok' ? '检查范围内正常' : groupState === 'finding' ? '发现问题 · 查看报告' : '需要复核 · 查看报告';
      set('[data-security-summary="' + group + '"]', label);
      scope?.querySelectorAll('[data-security-summary="' + group + '"]').forEach(node => { node.dataset.state = groupState; });
      set('[data-security-group-state="' + group + '"]', !trusted ? issue : items.length + ' 项已检查');
      for (const list of scope?.querySelectorAll('[data-security-group="' + group + '"]') ?? []) {
        list.replaceChildren();
        if (!trusted) {
          const row = document.createElement('li'); row.className = 'sc-empty-row'; row.textContent = issue + '；原始结果可在完整报告中查看'; list.append(row);
        } else for (const item of items) {
          const row = document.createElement('li'); row.dataset.state = item.state;
          row.textContent = item.name + ' · ' + (LABELS[item.state] || '未知') + ' · ' + item.detail;
          list.append(row);
        }
      }
    }
    set('[data-security-summary="backup"]', '系统运维入口 · 容灾待完善');
    set('[data-security-recent]', trusted && report.history?.length ? report.history.at(-1).name + ' · ' + (LABELS[report.history.at(-1).state] || '未知') : trusted ? '暂无状态变化记录' : issue + '，暂不能确认防护动态');
  }
  function clear(reason) {
    update(null, { issue: reason });
    scope?.querySelectorAll('[data-security-group]').forEach(node => { node.replaceChildren(); });
    open('home');
  }
  return Object.freeze({ bind, update, clear, setBusy });
}

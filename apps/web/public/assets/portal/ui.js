import { $ } from './core.js';

export function date(value) {
  if (!value) return '未设置';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString('zh-CN');
}

export function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

export function td(value, className) { return element('td', value == null || value === '' ? '—' : value, className); }

export function badge(status) {
  const value = { active: '正常', inactive: '已停用', disabled: '已停用', suspended: '已暂停', revoked: '已撤销', queued: '排队中', processing: '构建中', succeeded: '已完成', failed: '失败', draft: '草稿' }[status] ?? status ?? '—';
  const cell = element('td');
  cell.append(element('span', value, `badge ${['active', 'succeeded'].includes(status) ? 'success' : ['revoked', 'failed'].includes(status) ? 'failed' : ['processing', 'suspended'].includes(status) ? 'processing' : ''}`));
  return cell;
}

export function roleLabel(role) { return { owner: '平台所有者', super_admin: '超级管理员', license_ops: '授权运营', license_operator: '授权运营', release_manager: '版本管理员', support: '客服管理员', auditor: '审计员' }[role] ?? role ?? '未分配'; }
export function nodeRoleLabel(role) { return { 'build-center': '打包中心', worker: '构建 Worker' }[role] ?? role ?? '未知节点'; }
export function installationRoleLabel(role) { return { 'all-in-one': '完整系统', 'license-center': '授权中心', 'build-center': '打包中心', worker: '构建 Worker' }[role] ?? role ?? '未设置'; }
export function channelLabel(channel) { return { stable: '正式版', beta: '测试版', preview: '预览版' }[channel] ?? channel ?? '正式版'; }
export function releaseKindLabel(kind) { return { feature: '功能更新', security: '安全更新', hotfix: '问题修复' }[kind] ?? kind ?? '常规更新'; }
export function intentLabel(intent) { return { update: '更新包', reinstall: '重装包' }[intent] ?? '安装包'; }
export function ticketCategoryLabel(value) { return { packaging: '打包问题', build: '构建问题', install: '安装问题', license: '授权问题', consulting: '使用咨询' }[value] ?? value ?? '其他'; }
export function ticketPriorityLabel(value) { return { low: '低', normal: '普通', high: '较急', urgent: '紧急' }[value] ?? value ?? '普通'; }
export function ticketStatusLabel(value) { return { pending: '待处理', processing: '处理中', waiting_customer: '等客户', resolved: '已解决', closed: '已关闭' }[value] ?? value ?? '未知'; }

export function renderRows(id, items, count, render, empty = '暂无记录') {
  const target = $(id);
  target.replaceChildren();
  if (!items.length) {
    const row = element('tr');
    const emptyCell = td(empty, 'empty-cell');
    emptyCell.colSpan = count;
    row.append(emptyCell);
    target.append(row);
    return;
  }
  for (const item of items) target.append(render(item));
}

export function match(value, query) { return String(value ?? '').toLocaleLowerCase().includes(query); }
export function search(id) { return ($(id)?.value ?? '').trim().toLocaleLowerCase(); }

export function fileSize(value) {
  const size = Number(value) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function button(text, action, className = 'mini-button') {
  const node = element('button', text, className);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

export function progress(value) {
  const wrap = element('span');
  const track = element('span', null, 'progress-track');
  const fill = element('span', null, 'progress-fill');
  fill.style.width = `${Math.min(100, Math.max(0, Number(value) || 0))}%`;
  track.append(fill);
  wrap.append(track, element('span', `${value ?? 0}%`, 'progress-label'));
  return wrap;
}

export function progressCell(value) { const node = element('td'); node.append(progress(value)); return node; }

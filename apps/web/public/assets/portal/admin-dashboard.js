import { $ } from './core.js';
import {
  badge, button, channelLabel, date, element, installationRoleLabel, match, progressCell,
  releaseKindLabel, renderRows, search, td,
} from './ui.js';

export function createAdminDashboard(shell, collaborators) {
  const { can, request, notify, refresh, dialog, actions } = shell;
  const { licenseRow, membersUi, announcementUi, operationsUi, renderAdminTickets } = collaborators;

  function reviewDomainMigration(requestItem, decision) {
    const approved = decision === 'approved';
    dialog(approved ? '批准域名迁移' : '拒绝域名迁移', `${requestItem.customer_ref}：${requestItem.previous_domain} → ${requestItem.requested_domain}`, (card, close) => {
      const label = element('label', null, 'field');
      label.append(element('span', '审批备注（可选）'));
      const input = element('textarea');
      input.maxLength = 500;
      input.placeholder = approved ? '记录迁移窗口或注意事项' : '记录拒绝原因';
      label.append(input); card.append(label);
      actions(card, close, approved ? '确认批准' : '确认拒绝', async () => {
        await request(`/web/admin/domain-migrations/${encodeURIComponent(requestItem.id)}/review`, {
          method: 'POST', body: { decision, review_note: input.value.trim() },
        });
        notify(approved ? '域名迁移已批准' : '域名迁移已拒绝');
        await refresh();
      }, !approved);
    });
  }

  function migrationRow(requestItem) {
    const row = element('tr');
    row.append(td(requestItem.customer_ref), td(requestItem.previous_domain), td(requestItem.requested_domain), td(requestItem.reason), badge(requestItem.status), td(date(requestItem.requested_at)));
    const action = element('td', null, 'actions');
    if (requestItem.status === 'pending' && can('license.manage')) {
      action.append(
        button('批准', () => reviewDomainMigration(requestItem, 'approved')),
        button('拒绝', () => reviewDomainMigration(requestItem, 'rejected')),
      );
    }
    row.append(action);
    return row;
  }

  function buildRow(job) {
    const row = element('tr');
    row.append(td(job.build_id || job.id, 'key-inline'), td(job.version), td(job.domain), badge(job.status), progressCell(job.progress), td(job.message), td(date(job.created_at)));
    return row;
  }

  function withdrawVersion(version) {
    dialog('撤回主题版本', `${version.display_name || version.version} 撤回后不再允许客户创建新构建，历史数据不会删除。`, (card, close) => {
      const label = element('label', null, 'field');
      label.append(element('span', '撤回原因（至少 8 个字）'));
      const input = element('textarea'); input.required = true; input.minLength = 8; input.maxLength = 500;
      label.append(input); card.append(label);
      actions(card, close, '确认撤回', async () => {
        await request(`/web/admin/versions/${encodeURIComponent(version.id)}/withdraw`, { method: 'POST', body: { reason: input.value.trim() } });
        notify('版本已撤回'); await refresh();
      }, true);
    });
  }

  function render(data) {
    const stats = data.stats ?? {};
    const licenses = Array.isArray(data.licenses) ? data.licenses : [];
    const versions = Array.isArray(data.versions) ? data.versions : [];
    const builds = Array.isArray(data.builds) ? data.builds : [];
    const activations = Array.isArray(data.activations) ? data.activations : [];
    const migrations = Array.isArray(data.domain_migrations) ? data.domain_migrations : [];
    const audit = Array.isArray(data.audit) ? data.audit : [];
    const admins = Array.isArray(data.admins) ? data.admins : [];
    const tickets = Array.isArray(data.tickets) ? data.tickets : [];
    const cms = data.cms ?? {};
    const nodes = Array.isArray(cms.nodes) ? cms.nodes : [];

    $('stat-licenses').textContent = stats.licenses ?? licenses.length;
    $('stat-active').textContent = stats.activeLicenses ?? licenses.filter((item) => item.status === 'active').length;
    $('stat-builds').textContent = stats.buildsToday ?? 0;
    $('stat-activations').textContent = stats.activeActivations ?? activations.filter((item) => item.status === 'active').length;
    $('stat-queued').textContent = stats.queuedJobs ?? builds.filter((item) => item.status === 'queued').length;
    $('stat-versions').textContent = versions.filter((item) => item.status === 'active').length;
    renderRows('overview-build-list', builds.slice(0, 5), 4, (job) => {
      const row = element('tr'); row.append(td(job.version), td(job.domain), badge(job.status), progressCell(job.progress)); return row;
    });
    renderRows('overview-license-list', licenses.slice(0, 5), 5, (license) => {
      const row = element('tr'); row.append(td(license.customer_ref), td(license.bound_domain), badge(license.status), td(license.build_count), td(date(license.created_at))); return row;
    });

    const licenseQuery = search('license-search');
    const licenseStatus = $('license-status-filter').value;
    renderRows('license-list', licenses.filter((license) => (!licenseStatus || license.status === licenseStatus)
      && [license.customer_ref, license.bound_domain, license.key_prefix, license.plan_name, license.plan_code]
        .some((value) => match(value, licenseQuery))), 8, licenseRow, '没有匹配的授权');
    if ($('migration-count')) $('migration-count').textContent = `${migrations.length} 条记录`;
    if ($('migration-list')) renderRows('migration-list', migrations, 7, migrationRow, '暂无域名迁移申请');

    const list = $('version-list');
    if ($('version-count')) $('version-count').textContent = `${versions.length} 个版本`;
    if ($('version-total')) $('version-total').textContent = versions.length;
    if ($('version-active')) $('version-active').textContent = versions.filter((item) => item.status === 'active').length;
    if ($('version-draft')) $('version-draft').textContent = versions.filter((item) => item.status !== 'active').length;
    const versionQuery = search('version-search');
    const versionStatus = $('version-status-filter')?.value || '';
    const visibleVersions = versions.filter((version) => (!versionStatus || version.status === versionStatus)
      && [version.version, version.display_name, version.release_notes].some((value) => match(value, versionQuery)));
    list.replaceChildren();
    if (!visibleVersions.length) {
      const empty = element('div', null, 'empty-state');
      empty.append(element('span', '▦'), element('strong', '尚未发布版本'), element('p', '上传第一个正式主题包后，客户才能创建构建。'));
      list.append(empty);
    }
    for (const [index, version] of visibleVersions.entries()) {
      const item = element('article', null, 'release-item compact-release-item');
      const summary = element('div', null, 'release-summary');
      const title = element('div', null, 'version-name-row');
      title.append(element('strong', version.display_name || `APPGOG ${version.version}`));
      if (index === 0 && version.status === 'active') title.append(element('span', '最新', 'badge success'));
      title.append(element('span', version.access_tier === 'paid' ? '仅付费授权' : '免费授权可用', `badge ${version.access_tier === 'paid' ? '' : 'success'}`));
      summary.append(title,
        element('small', `${version.version || '—'} · ${channelLabel(version.channel)} · ${releaseKindLabel(version.release_kind)} · ${date(version.published_at || version.created_at)}`),
        element('p', version.release_notes || '暂无更新公告'));
      const meta = element('div', null, 'release-meta');
      meta.append(element('span', version.source_kind === 'official' ? '真实源码 ZIP' : version.source_kind || '源码未知'));
      summary.append(meta);
      const side = element('div', null, 'release-side');
      side.append(element('span', version.status === 'active' ? '已发布' : '草稿', `badge ${version.status === 'active' ? 'success' : ''}`));
      if (version.status === 'active' && can('version.manage')) side.append(button('撤回版本', () => withdrawVersion(version), 'mini-button mini-button-danger'));
      item.append(summary, side); list.append(item);
    }

    const buildQuery = search('admin-build-search');
    const buildStatus = $('build-status-filter').value;
    renderRows('admin-build-list', builds.filter((job) => (!buildStatus || job.status === buildStatus)
      && [job.version, job.domain, job.build_id, job.id].some((value) => match(value, buildQuery))), 7, buildRow, '没有匹配的构建任务');
    renderAdminTickets(tickets, admins);
    const activationQuery = search('activation-search');
    renderRows('activation-list', activations.filter((item) => [item.customer_ref, item.domain, item.backend_origin, item.version]
      .some((value) => match(value, activationQuery))), 7, (item) => {
      const row = element('tr');
      row.append(td(item.customer_ref), td(item.version), td(item.domain), td(item.backend_origin), badge(item.status), td(date(item.last_seen_at)), td(date(item.created_at)));
      return row;
    }, '没有匹配的激活站点');
    membersUi.render(admins, nodes);
    const auditQuery = search('audit-search');
    renderRows('audit-list', audit.filter((item) => [item.action, item.actor_type, item.actor_id, item.subject_type, item.subject_id]
      .some((value) => match(value, auditQuery))), 6, (item) => {
      const row = element('tr'); row.append(td(item.action), td(item.actor_type), td(item.actor_id), td(item.subject_type), td(item.subject_id), td(date(item.created_at))); return row;
    }, '没有匹配的审计记录');

    const cmsForm = $('cms-settings-form');
    if (cmsForm) {
      for (const key of ['platform_name', 'domain_migration_cooldown_hours']) {
        if (cmsForm.elements[key]) cmsForm.elements[key].value = cms[key] ?? '';
      }
    }
    announcementUi.render(cms);
    if ($('cms-role-badge')) $('cms-role-badge').textContent = installationRoleLabel(cms.installation_role);
    if ($('cms-license-url')) $('cms-license-url').textContent = cms.license_public_url ?? '—';
    if ($('cms-build-url')) $('cms-build-url').textContent = cms.build_public_url ?? '—';
    if ($('cms-installation-role')) $('cms-installation-role').textContent = installationRoleLabel(cms.installation_role);
    if ($('cms-service-status')) $('cms-service-status').textContent = [
      cms.license_service_enabled !== false ? '授权服务在线' : '授权服务停用',
      cms.build_center_enabled !== false ? '打包中心在线' : '打包中心停用',
      cms.worker_enabled !== false ? 'Worker 在线' : 'Worker 停用',
    ].join(' · ');
    operationsUi.refresh();
  }

  return Object.freeze({ render });
}

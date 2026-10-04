import { invariant } from '../../../../../packages/core/src/errors.js';
import { keyPrefix, newNodeCredential } from '../../../../../packages/core/src/identifiers.js';
import { hashSecret } from '../../../../../packages/core/src/security.js';

function publicNode(node) {
  let capabilities = [];
  try { capabilities = JSON.parse(node.capabilities_json ?? '[]'); } catch { capabilities = []; }
  return {
    id: node.id, name: node.name, role: node.role, public_url: node.public_url,
    credential_prefix: node.credential_prefix, status: node.status, capabilities,
    last_seen_at: node.last_seen_at, created_at: node.created_at, updated_at: node.updated_at,
  };
}

function optionalHttpUrl(value, code = 'CMS_URL_INVALID') {
  const text = String(value ?? '').trim();
  if (!text) return null;
  let parsed;
  try { parsed = new URL(text); } catch { invariant(false, code, '站点地址格式无效'); }
  invariant(['http:', 'https:'].includes(parsed.protocol), code, '站点地址必须使用 HTTP 或 HTTPS');
  return text.replace(/\/+$/, '');
}

export function createOperationsService({ repository, config, packageVersion = 'development', clock = () => new Date() }) {
  const serviceConfig = Object.freeze({
    license_service_enabled: 'licenseServiceEnabled', customer_login_enabled: 'customerLoginEnabled',
    build_center_enabled: 'buildCenterEnabled', new_builds_enabled: 'newBuildsEnabled', worker_enabled: 'workerEnabled',
  });
  const boolSetting = (key, fallback = true) => {
    const value = repository.setting(key);
    return value === null ? fallback : value === 'true';
  };
  const service = {
    branding() {
      return {
        platform_name: repository.listSettings().platform_name ?? 'APPGOG打包授权系统',
        system_version: packageVersion,
      };
    },
    authenticateServiceNode(credential, role) {
      if (!credential) return null;
      let node = null;
      try { node = repository.serviceNodeByCredentialHash(hashSecret(credential, config.pepper)); } catch { return null; }
      if (!node || node.role !== role || node.status !== 'active') return null;
      return repository.touchServiceNode(node.id, clock().toISOString());
    },
    healthStatus() {
      const since = new Date(clock().getTime() - 24 * 60 * 60 * 1000).toISOString();
      const stats = repository.dashboardStats(since);
      return { database: 'ok', queue: { pending: stats.queuedJobs } };
    },
    recordSystemUpdate(queued, actorId) {
      const now = clock().toISOString();
      repository.audit({ actorType: 'admin', actorId, action: `system_update.${queued.action}`,
        subjectType: 'system_update', subjectId: queued.id, metadata: { version: queued.version }, now });
      return queued;
    },
    serviceEnabled(key, fallback = true) {
      const property = serviceConfig[key];
      return property ? config[property] !== false : boolSetting(key, fallback);
    },
    cmsSettings() {
      const saved = repository.listSettings();
      const announcementEnabled = saved.announcement_enabled === 'true' && Boolean(saved.announcement_title?.trim() || saved.announcement_body?.trim());
      return {
        system_version: packageVersion,
        platform_name: saved.platform_name ?? 'APPGOG打包授权系统',
        installation_role: config.role ?? (config.surface === 'combined' ? 'all-in-one' : 'license-center'),
        license_public_url: config.publicBaseUrl, build_public_url: config.buildCenterPublicUrl,
        domain_migration_cooldown_hours: Math.max(0, Number(saved.domain_migration_cooldown_hours) || 0),
        announcement_title: saved.announcement_title ?? '', announcement_body: saved.announcement_body ?? '',
        announcement_enabled: announcementEnabled, announcement_published_at: saved.announcement_published_at ?? null,
        license_service_enabled: config.licenseServiceEnabled !== false,
        customer_login_enabled: config.customerLoginEnabled !== false,
        build_center_enabled: config.buildCenterEnabled !== false,
        new_builds_enabled: config.newBuildsEnabled !== false,
        worker_enabled: config.workerEnabled !== false,
        nodes: repository.listServiceNodes().map(publicNode),
      };
    },
    updateCmsSettings(input, actorId) {
      const now = clock().toISOString();
      const deploymentFields = ['license_public_url', 'build_public_url', 'license_service_enabled', 'customer_login_enabled', 'build_center_enabled', 'new_builds_enabled', 'worker_enabled'];
      invariant(!deploymentFields.some((key) => input[key] !== undefined), 'DEPLOYMENT_SETTING_READ_ONLY', '域名和服务开关只能通过 Linux appgog 管理菜单修改', 403);
      const textFields = ['platform_name', 'announcement_title', 'announcement_body'];
      const booleanFields = ['announcement_enabled'];
      for (const key of textFields) {
        if (input[key] === undefined) continue;
        const value = String(input[key]).trim();
        const maximum = key === 'announcement_body' ? 4000 : 200;
        invariant(key !== 'platform_name' || value.length >= 2, 'CMS_SETTING_INVALID', '平台名称至少 2 个字符');
        invariant(value.length <= maximum, 'CMS_SETTING_INVALID', `${key} 配置过长`);
        repository.setSetting(key, value, now);
      }
      for (const key of booleanFields) if (input[key] !== undefined) repository.setSetting(key, input[key] === true ? 'true' : 'false', now);
      if (input.domain_migration_cooldown_hours !== undefined) {
        const hours = Number(input.domain_migration_cooldown_hours);
        invariant(Number.isInteger(hours) && hours >= 0 && hours <= 8760, 'DOMAIN_MIGRATION_COOLDOWN_INVALID', '域名换绑冷却必须是 0–8760 小时的整数');
        repository.setSetting('domain_migration_cooldown_hours', String(hours), now);
      }
      if (input.announcement_enabled === true || input.announcement_title !== undefined || input.announcement_body !== undefined) {
        repository.setSetting('announcement_published_at', now, now);
      }
      repository.audit({ actorType: 'admin', actorId, action: 'cms.settings.updated', subjectType: 'system',
        subjectId: 'cms', metadata: { keys: [...textFields, ...booleanFields, 'domain_migration_cooldown_hours'].filter((key) => input[key] !== undefined) }, now });
      return service.cmsSettings();
    },
    updateAnnouncement(input, actorId) {
      const now = clock().toISOString();
      const title = String(input.title ?? '').trim();
      const body = String(input.body ?? '').trim();
      invariant(title.length <= 200, 'ANNOUNCEMENT_TITLE_INVALID', '公告标题不能超过 200 个字符');
      invariant(body.length <= 4000, 'ANNOUNCEMENT_BODY_INVALID', '公告正文不能超过 4000 个字符');
      const enabled = input.enabled === true && Boolean(title || body);
      repository.setSetting('announcement_title', title, now);
      repository.setSetting('announcement_body', body, now);
      repository.setSetting('announcement_enabled', enabled ? 'true' : 'false', now);
      repository.setSetting('announcement_published_at', now, now);
      repository.audit({ actorType: 'admin', actorId, action: 'announcement.updated', subjectType: 'system',
        subjectId: 'customer-announcement', metadata: { enabled, has_title: Boolean(title), has_body: Boolean(body) }, now });
      return service.cmsSettings();
    },
    createServiceNode(input, actorId) {
      invariant(['build-center', 'worker'].includes(input.role), 'NODE_ROLE_INVALID', '节点角色无效');
      const name = String(input.name ?? '').trim();
      invariant(name.length >= 2 && name.length <= 80, 'NODE_NAME_INVALID', '节点名称必须为 2–80 个字符');
      const credential = newNodeCredential(input.role);
      const now = clock().toISOString();
      const capabilities = input.role === 'worker' ? ['build.lease', 'build.transfer'] : ['customer.proxy'];
      const node = repository.createServiceNode({
        name, role: input.role, publicUrl: optionalHttpUrl(input.public_url, 'NODE_URL_INVALID'),
        credentialPrefix: keyPrefix(credential), credentialHash: hashSecret(credential, config.pepper), capabilities, now,
      });
      repository.audit({ actorType: 'admin', actorId, action: 'service_node.created', subjectType: 'service_node',
        subjectId: node.id, metadata: { name, role: input.role }, now });
      return { node: publicNode(node), credential };
    },
    changeServiceNodeStatus(id, status, actorId) {
      invariant(['active', 'disabled'].includes(status), 'NODE_STATUS_INVALID', '节点状态无效');
      const now = clock().toISOString();
      const node = repository.changeServiceNodeStatus(id, status, now);
      invariant(node, 'NODE_NOT_FOUND', '节点不存在', 404);
      repository.audit({ actorType: 'admin', actorId, action: `service_node.${status}`, subjectType: 'service_node', subjectId: id, now });
      return publicNode(node);
    },
    rotateServiceNodeCredential(id, actorId) {
      const current = repository.serviceNodeById(id);
      invariant(current, 'NODE_NOT_FOUND', '节点不存在', 404);
      const credential = newNodeCredential(current.role);
      const now = clock().toISOString();
      const node = repository.rotateServiceNodeCredential(id, keyPrefix(credential), hashSecret(credential, config.pepper), now);
      repository.audit({ actorType: 'admin', actorId, action: 'service_node.credential_rotated', subjectType: 'service_node', subjectId: id, now });
      return { node: publicNode(node), credential };
    },
  };
  return service;
}

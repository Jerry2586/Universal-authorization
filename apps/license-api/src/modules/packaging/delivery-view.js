// Read-only delivery projection. Build success is independent of activation.
export function buildDeliveryView(repository, job, now) {
  const record = job.build_id ? repository.buildDeliveryById(job.build_id) : null;
  if (!record) return { activation_state: 'not_installed', activation_label: '未激活', can_download: false };
  const expired = record.install_key_expires_at && record.install_key_expires_at <= now;
  let status = 'not_installed', label = '未激活';
  if (record.build_status === 'revoked' || record.license_status !== 'active') { status = 'revoked'; label = '授权已停用'; }
  else if (record.activation_status === 'active' && record.activation_generation === record.license_generation) { status = 'active'; label = '已激活'; }
  else if (record.activation_status) {
    status = record.activation_status === 'superseded' ? 'superseded' : 'revoked';
    label = status === 'superseded' ? '已被新安装替代' : '授权已失效';
  } else if (record.receipt_status === 'revoked') { status = 'revoked'; label = '安装授权已撤销'; }
  else if (record.install_key_status === 'consumed') { status = 'unlocked'; label = '未激活 · 本地已解锁'; }
  else if (expired || record.install_key_status === 'expired') { status = 'expired'; label = '安装 Key 已失效'; }
  return {
    activation_state: status, activation_label: label,
    can_download: job.status === 'succeeded' && record.build_status === 'ready'
      && record.install_key_status === 'available' && !expired && record.license_status === 'active',
    install_key_status: record.install_key_status, install_key_used_at: record.consumed_at,
    install_key_expires_at: record.install_key_expires_at,
    activated_at: record.activation_created_at || record.activated_at,
    activation_domain: record.domain, last_seen_at: record.last_seen_at,
  };
}

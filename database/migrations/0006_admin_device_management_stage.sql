-- 第七步：管理员设备管理查询和并发安全约束。
-- 旧表已经包含设备、绑定、封禁、会话、授权事件和审计日志；本迁移只补必要索引。

CREATE INDEX activations_tenant_license_time_idx
  ON activations (tenant_id, license_key_id, activated_at DESC, id DESC);

CREATE INDEX activations_tenant_device_status_idx
  ON activations (tenant_id, device_id, status);

CREATE INDEX device_blocks_tenant_device_status_idx
  ON device_blocks (tenant_id, device_id, status, blocked_at DESC)
  WHERE device_id IS NOT NULL;

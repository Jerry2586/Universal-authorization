-- 第八步：管理员审计日志与授权事件只读查询索引。
-- 旧表已经保存完整历史；本迁移只增加查询索引，不删除、不覆盖任何历史记录。

CREATE INDEX audit_logs_tenant_action_time_idx
  ON audit_logs (tenant_id, action, occurred_at DESC, id DESC);

CREATE INDEX audit_logs_tenant_result_time_idx
  ON audit_logs (tenant_id, result, occurred_at DESC, id DESC);

CREATE INDEX license_events_tenant_license_time_idx
  ON license_events (tenant_id, license_key_id, occurred_at DESC, id DESC)
  WHERE license_key_id IS NOT NULL;

CREATE INDEX license_events_tenant_device_time_idx
  ON license_events (tenant_id, device_id, occurred_at DESC, id DESC)
  WHERE device_id IS NOT NULL;

CREATE INDEX license_events_tenant_type_time_idx
  ON license_events (tenant_id, event_type, occurred_at DESC, id DESC);

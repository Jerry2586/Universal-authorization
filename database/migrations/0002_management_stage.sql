ALTER TABLE license_keys
  ADD COLUMN generation_batch_id UUID,
  ADD COLUMN duration_seconds BIGINT CHECK (duration_seconds IS NULL OR duration_seconds > 0),
  ADD COLUMN offline_grace_seconds INTEGER NOT NULL DEFAULT 86400
    CHECK (offline_grace_seconds >= 0),
  ADD COLUMN allow_self_unbind BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN unbind_cooldown_seconds INTEGER NOT NULL DEFAULT 604800
    CHECK (unbind_cooldown_seconds >= 0),
  ADD COLUMN suspended_from_status VARCHAR(24)
    CHECK (suspended_from_status IN ('ACTIVE'));

CREATE INDEX license_keys_generation_batch_idx
  ON license_keys (tenant_id, generation_batch_id)
  WHERE generation_batch_id IS NOT NULL;


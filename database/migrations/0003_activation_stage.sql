CREATE TABLE activation_idempotency_records (
  idempotency_key VARCHAR(128) PRIMARY KEY,
  request_hash VARCHAR(64) NOT NULL,
  status VARCHAR(24) NOT NULL CHECK (status IN ('PROCESSING', 'COMPLETED')),
  response_data JSONB,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK (status <> 'COMPLETED' OR (response_data IS NOT NULL AND completed_at IS NOT NULL))
);

CREATE INDEX activation_idempotency_expiry_idx
  ON activation_idempotency_records (expires_at);

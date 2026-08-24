ALTER TABLE session_heartbeats
  ADD COLUMN sequence BIGINT
    CHECK (sequence IS NULL OR sequence > 0);

CREATE UNIQUE INDEX session_heartbeats_session_sequence_uidx
  ON session_heartbeats (session_id, sequence)
  WHERE sequence IS NOT NULL AND result = 'ACCEPTED';

CREATE TABLE session_action_idempotency_records (
  action_type VARCHAR(32) NOT NULL
    CHECK (action_type IN ('SESSION_RELEASE', 'DEVICE_UNBIND')),
  idempotency_key VARCHAR(128) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  status VARCHAR(24) NOT NULL
    CHECK (status IN ('PROCESSING', 'COMPLETED')),
  response_data JSONB,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (action_type, idempotency_key),
  CHECK (
    status <> 'COMPLETED'
    OR (response_data IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX session_action_idempotency_expiry_idx
  ON session_action_idempotency_records (expires_at);

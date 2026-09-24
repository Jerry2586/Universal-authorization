export const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS license_plans (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  limits_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  customer_ref TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_encrypted TEXT,
  status TEXT NOT NULL,
  bound_domain TEXT,
  update_until TEXT,
  max_builds_per_day INTEGER NOT NULL DEFAULT 3,
  max_activations INTEGER NOT NULL DEFAULT 1,
  plan_id TEXT REFERENCES license_plans(id),
  generation INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS license_events (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id),
  event_type TEXT NOT NULL,
  build_id TEXT,
  activation_id TEXT,
  installation_id TEXT,
  result TEXT NOT NULL DEFAULT 'success',
  reason_code TEXT,
  actor_type TEXT NOT NULL DEFAULT 'system',
  actor_id TEXT,
  request_ip TEXT,
  user_agent TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS build_tickets (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id),
  token_hash TEXT NOT NULL UNIQUE,
  requested_version TEXT NOT NULL,
  requested_domain TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  claimed_at TEXT,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS builds (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id),
  ticket_id TEXT NOT NULL UNIQUE REFERENCES build_tickets(id),
  version TEXT NOT NULL,
  domain TEXT NOT NULL,
  package_id TEXT NOT NULL UNIQUE,
  package_secret_hash TEXT NOT NULL,
  artifact_sha256 TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  activated_at TEXT
);

CREATE TABLE IF NOT EXISTS install_keys (
  id TEXT PRIMARY KEY,
  build_id TEXT NOT NULL UNIQUE REFERENCES builds(id),
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  expires_at TEXT,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS install_receipts (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id),
  build_id TEXT NOT NULL UNIQUE REFERENCES builds(id),
  receipt_secret_hash TEXT NOT NULL UNIQUE,
  domain TEXT NOT NULL,
  backend_origin TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  status TEXT NOT NULL,
  generation INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS activations (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id),
  build_id TEXT NOT NULL REFERENCES builds(id),
  domain TEXT NOT NULL,
  backend_origin TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  status TEXT NOT NULL,
  generation INTEGER NOT NULL,
  refresh_secret_hash TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  identity_mode TEXT NOT NULL DEFAULT 'legacy',
  installation_public_key_fingerprint TEXT,
  UNIQUE(build_id, domain, installation_id)
);

CREATE TABLE IF NOT EXISTS installation_identities (
  installation_id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id),
  public_key_pem TEXT NOT NULL,
  public_key_fingerprint TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  ownership_generation INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  fenced_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS installation_challenges (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  public_key_fingerprint TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  nonce TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'created',
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_migration_grants (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id),
  source_installation_id TEXT NOT NULL,
  target_public_key_fingerprint TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'issued',
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  rollback_until TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS domain_migration_requests (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id),
  previous_domain TEXT NOT NULL,
  requested_domain TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  requested_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT REFERENCES admin_users(id),
  review_note TEXT
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'support',
  permissions_json TEXT NOT NULL DEFAULT '[]',
  is_owner INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  last_login_at TEXT,
  last_login_ip TEXT,
  deleted_at TEXT,
  deleted_username TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS web_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_versions (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  version TEXT NOT NULL,
  display_name TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_ref TEXT,
  status TEXT NOT NULL,
  release_notes TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT 'stable',
  release_kind TEXT NOT NULL DEFAULT 'feature',
  min_xboard_version TEXT,
  min_upgrade_version TEXT,
  rollback_allowed INTEGER NOT NULL DEFAULT 1,
  rollback_to TEXT,
  withdrawn_reason TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(product_id, version)
);

CREATE TABLE IF NOT EXISTS build_jobs (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id),
  source_version_id TEXT REFERENCES source_versions(id),
  requested_version TEXT NOT NULL,
  requested_domain TEXT NOT NULL,
  intent TEXT NOT NULL DEFAULT 'install',
  base_version TEXT,
  source_kind TEXT NOT NULL,
  upload_ref TEXT,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  status_message TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  build_id TEXT REFERENCES builds(id),
  artifact_ref TEXT,
  artifact_sha256 TEXT,
  install_key_encrypted TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS service_nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  public_url TEXT,
  credential_prefix TEXT NOT NULL,
  credential_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS control_plane_identity (
  id TEXT PRIMARY KEY CHECK (id = 'primary'),
  deployment_id TEXT NOT NULL UNIQUE,
  ownership_generation INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  active_migration_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS control_migrations (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL,
  target_url TEXT,
  source_deployment_id TEXT,
  target_deployment_id TEXT,
  ownership_generation INTEGER NOT NULL,
  status TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  preflight_json TEXT NOT NULL DEFAULT '{}',
  bundle_sha256 TEXT,
  failure_code TEXT,
  failure_message TEXT,
  requested_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id TEXT PRIMARY KEY,
  ticket_number TEXT NOT NULL UNIQUE,
  license_id TEXT NOT NULL REFERENCES licenses(id),
  build_job_id TEXT REFERENCES build_jobs(id),
  category TEXT NOT NULL,
  subject TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'pending',
  assigned_admin_id TEXT REFERENCES admin_users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  closed_at TEXT,
  closed_by_type TEXT,
  closed_by_id TEXT,
  close_reason TEXT,
  reopened_at TEXT,
  reopened_by TEXT
);

CREATE TABLE IF NOT EXISTS support_messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES support_tickets(id),
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  body TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'public',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS support_attachments (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES support_tickets(id),
  message_id TEXT REFERENCES support_messages(id),
  original_name TEXT NOT NULL,
  storage_ref TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS erasure_jobs (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  file_refs_json TEXT NOT NULL DEFAULT '[]',
  error_message TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS erasure_tombstones (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  deleted_at TEXT NOT NULL,
  execution_version TEXT NOT NULL,
  records_deleted INTEGER NOT NULL,
  files_deleted INTEGER NOT NULL,
  result TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS file_cleanup_tasks (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  storage_ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(operation_id, storage_ref)
);

CREATE INDEX IF NOT EXISTS idx_licenses_product ON licenses(product_id);
CREATE INDEX IF NOT EXISTS idx_license_events_license ON license_events(license_id, created_at);
CREATE INDEX IF NOT EXISTS idx_builds_license ON builds(license_id);
CREATE INDEX IF NOT EXISTS idx_install_receipts_license ON install_receipts(license_id);
CREATE INDEX IF NOT EXISTS idx_activations_license ON activations(license_id);
CREATE INDEX IF NOT EXISTS idx_installation_identities_license ON installation_identities(license_id, status);
CREATE INDEX IF NOT EXISTS idx_installation_challenges_expiry ON installation_challenges(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_product_migration_grants_license ON product_migration_grants(license_id, status);
CREATE INDEX IF NOT EXISTS idx_domain_migrations_license ON domain_migration_requests(license_id, requested_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_migrations_pending ON domain_migration_requests(license_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON web_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_source_versions_product ON source_versions(product_id, status);
CREATE INDEX IF NOT EXISTS idx_build_jobs_status ON build_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_control_migrations_status ON control_migrations(status, created_at);
CREATE INDEX IF NOT EXISTS idx_build_jobs_license ON build_jobs(license_id, created_at);
CREATE INDEX IF NOT EXISTS idx_service_nodes_role ON service_nodes(role, status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_license ON support_tickets(license_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_support_tickets_queue ON support_tickets(status, priority, updated_at);
CREATE INDEX IF NOT EXISTS idx_support_messages_ticket ON support_messages(ticket_id, created_at);
CREATE INDEX IF NOT EXISTS idx_support_attachments_ticket ON support_attachments(ticket_id, created_at);
CREATE INDEX IF NOT EXISTS idx_erasure_jobs_status ON erasure_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_file_cleanup_tasks_status ON file_cleanup_tasks(status, updated_at);
`;

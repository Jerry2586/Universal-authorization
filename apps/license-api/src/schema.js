export const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  customer_ref TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  bound_domain TEXT,
  update_until TEXT,
  max_builds_per_day INTEGER NOT NULL DEFAULT 3,
  generation INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
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
  UNIQUE(build_id, domain, installation_id)
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

CREATE INDEX IF NOT EXISTS idx_licenses_product ON licenses(product_id);
CREATE INDEX IF NOT EXISTS idx_builds_license ON builds(license_id);
CREATE INDEX IF NOT EXISTS idx_activations_license ON activations(license_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON web_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_source_versions_product ON source_versions(product_id, status);
CREATE INDEX IF NOT EXISTS idx_build_jobs_status ON build_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_build_jobs_license ON build_jobs(license_id, created_at);
CREATE INDEX IF NOT EXISTS idx_service_nodes_role ON service_nodes(role, status);
`;

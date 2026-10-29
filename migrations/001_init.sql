-- RSLMC initial schema. SQLite (WAL) — foreign keys enforced by the driver.
PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  is_root INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_recovery TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  avatar_color TEXT NOT NULL DEFAULT '#1f6f4a',
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  secret INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  fqdn TEXT NOT NULL,
  scheme TEXT NOT NULL DEFAULT 'http',
  port INTEGER NOT NULL DEFAULT 8443,
  location TEXT,
  is_local INTEGER NOT NULL DEFAULT 0,
  public INTEGER NOT NULL DEFAULT 1,
  maintenance INTEGER NOT NULL DEFAULT 0,
  agent_secret_hash TEXT,
  enrollment_token_hash TEXT,
  daemon_version TEXT,
  meta TEXT,
  last_heartbeat_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE java_runtimes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
  major INTEGER NOT NULL,
  vendor TEXT NOT NULL DEFAULT 'Eclipse Temurin',
  version TEXT NOT NULL,
  os TEXT NOT NULL,
  arch TEXT NOT NULL,
  image_type TEXT NOT NULL DEFAULT 'jdk',
  path TEXT NOT NULL,
  java_executable TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  checksum TEXT,
  status TEXT NOT NULL DEFAULT 'installed',
  verified_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(node_id, major, os, arch, image_type)
);

CREATE TABLE allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  ip TEXT NOT NULL,
  port INTEGER NOT NULL,
  ip_alias TEXT,
  server_id INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(node_id, ip, port)
);

CREATE TABLE servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  node_id INTEGER NOT NULL REFERENCES nodes(id),
  software TEXT NOT NULL,
  software_version TEXT NOT NULL DEFAULT '',
  mc_version TEXT NOT NULL,
  java_runtime_id INTEGER REFERENCES java_runtimes(id),
  java_major INTEGER NOT NULL DEFAULT 21,
  status TEXT NOT NULL DEFAULT 'offline',
  memory_mb INTEGER NOT NULL DEFAULT 2048,
  cpu_percent INTEGER NOT NULL DEFAULT 100,
  disk_mb INTEGER NOT NULL DEFAULT 10240,
  bind_ip TEXT NOT NULL DEFAULT '0.0.0.0',
  port INTEGER NOT NULL,
  query_port INTEGER,
  rcon_port INTEGER,
  rcon_password TEXT,
  startup_command TEXT NOT NULL DEFAULT 'java -Xms{memory}M -Xmx{memory}M -jar server.jar nogui',
  jvm_args TEXT NOT NULL DEFAULT '',
  server_args TEXT NOT NULL DEFAULT 'nogui',
  auto_start INTEGER NOT NULL DEFAULT 0,
  crash_recovery INTEGER NOT NULL DEFAULT 0,
  environment TEXT,
  enforcement TEXT,
  install_log TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  installed_at TEXT,
  last_started_at TEXT
);
CREATE INDEX idx_servers_node ON servers(node_id);
CREATE INDEX idx_servers_owner ON servers(owner_id);
CREATE INDEX idx_servers_status ON servers(status);

CREATE TABLE server_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  allocation_id INTEGER NOT NULL REFERENCES allocations(id) ON DELETE CASCADE,
  primary_port INTEGER NOT NULL DEFAULT 0,
  UNIQUE(server_id, allocation_id)
);

CREATE TABLE installed_software (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  build TEXT,
  source TEXT,
  sha256 TEXT,
  file_name TEXT,
  installed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE server_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  cpu_percent REAL NOT NULL DEFAULT 0,
  mem_bytes INTEGER NOT NULL DEFAULT 0,
  disk_bytes INTEGER NOT NULL DEFAULT 0,
  players INTEGER NOT NULL DEFAULT 0,
  net_rx_bytes INTEGER NOT NULL DEFAULT 0,
  net_tx_bytes INTEGER NOT NULL DEFAULT 0,
  tps REAL
);
CREATE INDEX idx_metrics_server_ts ON server_metrics(server_id, ts);

CREATE TABLE players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  uuid TEXT NOT NULL,
  username TEXT NOT NULL,
  online INTEGER NOT NULL DEFAULT 0,
  session_start_at TEXT,
  playtime_seconds INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT,
  last_join_at TEXT,
  UNIQUE(server_id, uuid)
);
CREATE INDEX idx_players_server ON players(server_id);

CREATE TABLE player_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  player_uuid TEXT NOT NULL,
  username TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  left_at TEXT,
  duration_seconds INTEGER
);
CREATE INDEX idx_player_sessions_server ON player_sessions(server_id, joined_at);

CREATE TABLE operators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  uuid TEXT NOT NULL,
  name TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 4,
  bypasses_player_limit INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(server_id, uuid)
);

CREATE TABLE whitelist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  uuid TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(server_id, uuid)
);

CREATE TABLE bans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  uuid TEXT,
  name TEXT,
  ip TEXT,
  type TEXT NOT NULL DEFAULT 'player',
  reason TEXT,
  source TEXT DEFAULT 'RSLMC',
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_bans_server ON bans(server_id);

CREATE TABLE plugins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  project_id TEXT,
  slug TEXT,
  version TEXT,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  target_dir TEXT NOT NULL DEFAULT 'plugins',
  source TEXT NOT NULL DEFAULT 'upload',
  sha256 TEXT,
  enabled INTEGER,
  update_version TEXT,
  installed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(server_id, file_name)
);

CREATE TABLE backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL DEFAULT 'full',
  file_name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  sha256 TEXT,
  created_by TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);
CREATE INDEX idx_backups_server ON backups(server_id);

CREATE TABLE schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  action TEXT NOT NULL,
  payload TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT,
  last_result TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE schedule_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  output TEXT
);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  severity TEXT NOT NULL DEFAULT 'info',
  kind TEXT NOT NULL DEFAULT 'system',
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  dedupe_key TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_notifications_user ON notifications(user_id, created_at);
CREATE UNIQUE INDEX idx_notifications_dedupe ON notifications(dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE activity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE,
  actor_id INTEGER,
  actor_name TEXT,
  type TEXT NOT NULL,
  target TEXT,
  result TEXT NOT NULL DEFAULT 'success',
  metadata TEXT
);
CREATE INDEX idx_activity_server ON activity_events(server_id, ts);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor_id INTEGER,
  actor_name TEXT,
  ip TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  result TEXT NOT NULL DEFAULT 'success',
  metadata TEXT
);
CREATE INDEX idx_audit_ts ON audit_events(ts);

CREATE TABLE worlds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  folder TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'overworld',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  seed TEXT,
  protected INTEGER NOT NULL DEFAULT 0,
  last_updated TEXT,
  UNIQUE(server_id, folder)
);

CREATE TABLE map_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL UNIQUE REFERENCES servers(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'none',
  status TEXT NOT NULL DEFAULT 'not_configured',
  progress REAL NOT NULL DEFAULT 0,
  public_url TEXT,
  worlds TEXT,
  note TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE download_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  server_id INTEGER,
  url TEXT,
  destination TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);

CREATE TABLE node_heartbeats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  stats TEXT
);
CREATE INDEX idx_heartbeat_node_ts ON node_heartbeats(node_id, ts);

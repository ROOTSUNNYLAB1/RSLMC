-- Per-server sub-user access used by the authorization layer.
CREATE TABLE server_subusers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permissions TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(server_id, user_id)
);
CREATE INDEX idx_subusers_user ON server_subusers(user_id);

-- Panel-level configuration that must be queryable (as opposed to key/value settings).
CREATE TABLE panel_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

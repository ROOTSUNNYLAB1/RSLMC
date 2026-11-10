-- Cloudflare Tunnel, per node (round 59).
--
-- One row per node: the operator's choice of mode (their own domain via a Zero Trust tunnel, or a
-- temporary trycloudflare.com hostname), the hostname to publish, and — for token mode — the tunnel
-- token, sealed with AES-256-GCM by the panel (see src/security/secrets.ts). The token column holds
-- ciphertext only: a copy of this database alone cannot be used to reach anyone's Cloudflare account.
CREATE TABLE IF NOT EXISTS node_tunnels (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id         INTEGER NOT NULL UNIQUE REFERENCES nodes(id) ON DELETE CASCADE,
  mode            TEXT    NOT NULL DEFAULT 'token' CHECK (mode IN ('token','quick')),
  hostname        TEXT,
  token_sealed    TEXT,
  local_scheme    TEXT    NOT NULL DEFAULT 'http',
  local_host      TEXT    NOT NULL DEFAULT '127.0.0.1',
  local_port      INTEGER NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  status          TEXT    NOT NULL DEFAULT 'stopped' CHECK (status IN ('stopped','starting','running','failed')),
  last_error      TEXT,
  last_started_at TEXT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_node_tunnels_status ON node_tunnels(status);

-- Multi-node support: a controller panel drives one or more node panels.
--
-- A "node" is another RSLMC installation on another machine. The controller keeps the account,
-- role and server records (so RBAC and the server list have one source of truth), and every
-- per-server request for a remote server is forwarded to the node that owns it. The link table
-- maps the controller's server id to the node's own id, so paths can be rewritten on the way.
--
-- The agent key lives on the *node* (settings.node_agent_key_hash), never on the controller:
-- the node is the one that has to decide whether to trust an incoming controller request.

CREATE TABLE IF NOT EXISTS node_server_links (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id        INTEGER NOT NULL UNIQUE REFERENCES servers(id) ON DELETE CASCADE,
  node_id          INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  remote_server_id INTEGER NOT NULL,
  remote_uuid      TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_node_links_node ON node_server_links(node_id);

-- Health of a node as last measured by the controller: the handshake result and the host stats the
-- node reported. Kept as a small JSON blob so the node page can render live figures without
-- re-probing on every page load, and can say plainly when the data is stale.
ALTER TABLE nodes ADD COLUMN last_status TEXT;
ALTER TABLE nodes ADD COLUMN last_error TEXT;
ALTER TABLE nodes ADD COLUMN stats_json TEXT;
ALTER TABLE nodes ADD COLUMN last_checked_at TEXT;
ALTER TABLE nodes ADD COLUMN api_version INTEGER NOT NULL DEFAULT 0;
-- The agent key the controller sends to the node. It has to be readable to be sent, so it lives in
-- its own column and never appears in a list response (see admin-routes.ts publicNode()).
ALTER TABLE nodes ADD COLUMN agent_key TEXT;

-- Counter of accepted controller requests, useful when a node is being debugged from its own UI.
CREATE TABLE IF NOT EXISTS node_agent_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  kind      TEXT NOT NULL,
  detail    TEXT
);

-- Single sign-on: Discord, and Google through Firebase.
CREATE TABLE IF NOT EXISTS user_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT,
  display_name TEXT,
  avatar_url TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at TEXT,
  UNIQUE(provider, subject)
);
CREATE INDEX IF NOT EXISTS idx_identities_user ON user_identities(user_id);

-- Short-lived, single-use OAuth state (CSRF nonce for the redirect dance + PKCE verifier).
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL
);

-- A verified identity that still owes a TOTP code before it gets a session.
CREATE TABLE IF NOT EXISTS oauth_tickets (
  ticket TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value, secret) VALUES ('oauth.discord.enabled', '0', 0);
INSERT OR IGNORE INTO settings (key, value, secret) VALUES ('oauth.discord.clientId', '', 0);
INSERT OR IGNORE INTO settings (key, value, secret) VALUES ('oauth.discord.clientSecret', '', 1);
INSERT OR IGNORE INTO settings (key, value, secret) VALUES ('oauth.google.enabled', '0', 0);
INSERT OR IGNORE INTO settings (key, value, secret) VALUES ('oauth.google.clientId', '', 0);
INSERT OR IGNORE INTO settings (key, value, secret) VALUES ('oauth.google.clientSecret', '', 1);
INSERT OR IGNORE INTO settings (key, value, secret) VALUES ('oauth.google.firebaseApiKey', '', 1);
INSERT OR IGNORE INTO settings (key, value, secret) VALUES ('oauth.google.firebaseProjectId', '', 0);
INSERT OR IGNORE INTO settings (key, value, secret) VALUES ('oauth.allowRegistration', '1', 0);
INSERT OR IGNORE INTO settings (key, value, secret) VALUES ('oauth.linkByEmail', '1', 0);

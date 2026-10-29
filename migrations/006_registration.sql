-- Self-registration for panel accounts. Disabled by default: an open panel is a security decision,
-- so an administrator has to turn it on explicitly under Administration → Users.
INSERT OR IGNORE INTO settings (key, value, secret) VALUES ('registration.enabled', '0', 0);
INSERT OR IGNORE INTO settings (key, value, secret) VALUES ('registration.requireApproval', '1', 0);
INSERT OR IGNORE INTO settings (key, value, secret) VALUES ('registration.requireCode', '0', 0);
INSERT OR IGNORE INTO settings (key, value, secret) VALUES ('registration.defaultRole', 'Viewer', 0);
INSERT OR IGNORE INTO settings (key, value, secret) VALUES ('registration.inviteCode', '', 1);

-- Fast lookup for "did somebody already register this address" and for pending-approval counts.
CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at);

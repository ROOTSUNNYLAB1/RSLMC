-- Round 27: a plain "User" account may force-kill its own server (a hung JVM is exactly what kill is
-- for) and choose a JVM preset from a curated list. The allocation, the raw flags and the command
-- line stay with server.settings (administrators only).
INSERT OR IGNORE INTO role_permissions (role_id, permission)
  SELECT id, 'server.kill' FROM roles WHERE name = 'User';
INSERT OR IGNORE INTO role_permissions (role_id, permission)
  SELECT id, 'server.startup' FROM roles WHERE name = 'User';

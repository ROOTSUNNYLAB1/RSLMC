-- Round 26: registration no longer has an approval queue, and fresh accounts start from the
-- least-powerful "User" role (seeded in src/shared/permissions.ts) instead of "Viewer".
DELETE FROM settings WHERE key = 'registration.requireApproval';

UPDATE settings SET value = 'User'
WHERE key = 'registration.defaultRole' AND (value = '' OR value = 'Viewer');

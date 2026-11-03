-- Two-factor authentication: a replay ledger for used codes.
--
-- A TOTP code is valid for up to 90 seconds (the current step plus one either way, to tolerate clock
-- skew), which meant the same six digits could be replayed from a network capture or a shoulder-surfed
-- screen. `totp_last_step` records the last counter value that was accepted; a code from that step or
-- an earlier one is refused. It is also the row where a single-use *recovery* code is consumed from
-- `totp_recovery` (which has existed since 001_init.sql but was never read).
ALTER TABLE users ADD COLUMN totp_last_step INTEGER;

-- Cheap lookup for "who has 2FA on" (the login path already reads the row, this is for admin views).
CREATE INDEX IF NOT EXISTS idx_users_totp_enabled ON users(totp_enabled);

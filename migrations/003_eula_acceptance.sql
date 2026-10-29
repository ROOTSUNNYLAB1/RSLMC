-- The Minecraft EULA is accepted once, in the creation wizard / EULA prompt.
-- Remembering that decision lets a reinstall (or a wiped server directory) restore
-- eula.txt instead of dead-ending the Start action with "EULA has not been accepted".
ALTER TABLE servers ADD COLUMN eula_accepted INTEGER NOT NULL DEFAULT 0;

-- Servers created before this migration may well have accepted the EULA during setup;
-- the ones that still have a working eula.txt are marked as accepted so a reinstall
-- does not regress them.
UPDATE servers SET eula_accepted = 1 WHERE installed_at IS NOT NULL;

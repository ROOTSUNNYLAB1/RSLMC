-- Port allocations were never released when a server was deleted, so the next server that
-- asked for the same port hit "UNIQUE constraint failed: allocations.node_id, allocations.ip,
-- allocations.port" and could not be created. Release the ones that point at nothing.
DELETE FROM allocations
WHERE server_id IS NOT NULL
  AND server_id NOT IN (SELECT id FROM servers);

-- Same case for rows whose server_id was never set but that were created for a server that
-- no longer exists (older builds left the note behind).
UPDATE allocations SET server_id = NULL
WHERE server_id IS NOT NULL AND server_id = 0;

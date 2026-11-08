-- Python and Node.js servers.
--
-- These runtimes are software in their own right, not Minecraft jars: the panel stores which
-- interpreter version they use, which file starts them, and which account the kernel runs them as.
-- Keeping those three in the row means a server keeps its identity across a panel restart, and that
-- the console can say "running as rslmc-nonroot" instead of guessing.
--
-- Existing servers are Minecraft servers: `entry_file` stays NULL and `service_user` is only written
-- for the runtimes that are actually isolated.
ALTER TABLE servers ADD COLUMN entry_file TEXT;
-- The account the process was last started as (Linux only). Recorded, not assumed: the panel reports
-- the uid it really spawned with, so an isolation failure is visible rather than claimed.
ALTER TABLE servers ADD COLUMN service_user TEXT;
CREATE INDEX IF NOT EXISTS idx_servers_software ON servers(software);

-- Dockered servers.
--
-- A server either runs as a JVM the panel starts (standalone) or inside a Docker container. The
-- choice is per server and is stored, because it decides how the server is started, stopped, measured
-- and cleaned up — and because losing it on restart would turn a container server into one the panel
-- tries to start with `java` and then reports as broken.
--
-- Existing rows default to standalone: that is what they are.
ALTER TABLE servers ADD COLUMN runtime TEXT NOT NULL DEFAULT 'standalone';
-- The image is stored explicitly rather than derived at boot: a Java major can map to a yolks tag
-- today and to a Temurin tag after a registry outage, and a running server must not change identity
-- because of that.
ALTER TABLE servers ADD COLUMN docker_image TEXT;
-- Set to 1 when the daemon accepted `--storage-opt size=`, so the UI only claims a disk limit where
-- one is really enforced.
ALTER TABLE servers ADD COLUMN docker_disk_quota INTEGER NOT NULL DEFAULT 0;

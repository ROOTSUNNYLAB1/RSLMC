-- Public / playit-style address.
--
-- Port-forwarding tools (playit.gg, ngrok, FRP tunnels…) hand out a hostname that players must use
-- instead of the machine's own IP. It is stored separately from bind_ip/port — those still describe
-- how the JVM listens locally, and changing one must never silently change the other.
ALTER TABLE servers ADD COLUMN public_host TEXT;
ALTER TABLE servers ADD COLUMN public_port INTEGER;

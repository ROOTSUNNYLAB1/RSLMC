-- What the controller last saw of a node's tunnel (round 59).
--
-- The tunnel itself lives on the node — its row is in that machine's database. The controller needs a
-- copy of the answer for a reason that is easy to miss: the moment a tunnel address is broken is also
-- the moment the node cannot be asked. Without a cached hostname, "use the tunnel address" is a button
-- that only works when it is not needed.
ALTER TABLE nodes ADD COLUMN tunnel_hostname TEXT;
ALTER TABLE nodes ADD COLUMN tunnel_mode TEXT;
ALTER TABLE nodes ADD COLUMN tunnel_status TEXT;
ALTER TABLE nodes ADD COLUMN tunnel_seen_at TEXT;

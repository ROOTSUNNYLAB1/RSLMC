-- Profile pictures. The bytes live on disk under <data>/avatars; the row only remembers which file
-- belongs to the account and a version counter used for cache busting and ETags.
ALTER TABLE users ADD COLUMN avatar_file TEXT;
ALTER TABLE users ADD COLUMN avatar_version INTEGER NOT NULL DEFAULT 0;

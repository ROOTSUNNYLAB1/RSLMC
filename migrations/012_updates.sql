-- Panel update state and history.
--
-- One row (id = 1) holds the settings and the last known release, so the panel can show
-- "update available" the moment it boots instead of waiting for the first network round-trip.
-- Jobs and restarts are separate tables: they are append-only history and the About page renders
-- them as a timeline ("installed 2026.10.29, restarted 41 s later").

CREATE TABLE IF NOT EXISTS panel_update_settings (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  auto_check        INTEGER NOT NULL DEFAULT 1,
  include_prerelease INTEGER NOT NULL DEFAULT 0,
  interval_minutes  INTEGER NOT NULL DEFAULT 360,
  repository        TEXT NOT NULL DEFAULT 'ROOTSUNNYLAB1/RSLMC',
  -- Cached result of the last successful check.
  latest_version    TEXT,
  latest_name       TEXT,
  latest_notes      TEXT,
  latest_url        TEXT,
  latest_asset_url  TEXT,
  latest_asset_name TEXT,
  latest_sha256     TEXT,
  latest_verified   INTEGER NOT NULL DEFAULT 0,
  latest_published_at TEXT,
  latest_prerelease INTEGER NOT NULL DEFAULT 0,
  last_checked_at   TEXT,
  last_check_error  TEXT,
  etag              TEXT,
  -- A version the operator dismissed; the banner stays quiet for it until something newer appears.
  dismissed_version TEXT,
  -- Set while an installed update is waiting for the restart that applies it.
  pending_restart_version TEXT,
  installed_at      TEXT,
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO panel_update_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS panel_update_jobs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  target_version TEXT NOT NULL,
  status         TEXT NOT NULL,           -- running | success | failed | cancelled
  stage          TEXT,
  steps          TEXT NOT NULL DEFAULT '[]',
  error          TEXT,
  actor_id       INTEGER,
  actor_name     TEXT,
  started_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_update_jobs_started ON panel_update_jobs (started_at DESC);

CREATE TABLE IF NOT EXISTS panel_restarts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL DEFAULT 'manual',   -- manual | update | recovery
  reason        TEXT,
  actor_id      INTEGER,
  actor_name    TEXT,
  requested_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- Written by the *old* process before it exits; the new one fills in the rest.
  stopped_at    TEXT,
  completed_at  TEXT,
  boot_ms       INTEGER,
  from_version  TEXT,
  to_version    TEXT,
  servers_kept  INTEGER NOT NULL DEFAULT 0,
  note          TEXT
);

CREATE INDEX IF NOT EXISTS idx_restarts_requested ON panel_restarts (requested_at DESC);

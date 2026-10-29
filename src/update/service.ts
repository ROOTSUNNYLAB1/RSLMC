import { queryOne, run } from "../database";
import { APP_VERSION } from "../shared/config";
import { compareCalVer, describeReleaseAge, isNewerCalVer, isCalVer } from "../shared/calver";
import { notify } from "../services/notifications";
import { recordActivity } from "../services/audit";
import { bus } from "../events/bus";
import { query } from "../database";
import {
  GitHubError, checksumAsset, installerAsset, listAvailableVersions, repositorySlug, repositoryUrl,
  type GitHubRelease,
} from "./github";

/**
 * Update state for the panel itself.
 *
 * The rules this module follows, in the same spirit as the rest of RSLMC:
 *
 *  - The panel *checks* on its own schedule but it never claims to be current when it could not
 *    check. `lastCheckError` is surfaced in the UI exactly as GitHub reported it.
 *  - A notification is raised once per version (dedupe key), not once per poll.
 *  - Nothing is downloaded or installed without an administrator pressing the button.
 *  - Settings live in SQLite, not in a config file, so the About page is the single place to
 *    change them and an update can never overwrite an operator's choice.
 *  - The check itself is the only outbound request: no telemetry, no identifiers, no token.
 */

export interface UpdateSettings {
  autoCheck: boolean;
  includePrerelease: boolean;
  intervalMinutes: number;
  repository: string;
}

export interface UpdateCandidate {
  version: string;
  name: string;
  notes: string;
  url: string;
  publishedAt: string | null;
  prerelease: boolean;
  calver: boolean;
  releaseAge: string | null;
  assetName: string | null;
  assetUrl: string | null;
  assetSize: number | null;
  sha256: string | null;
  /** True when the release publishes a checksum file the installer can verify against. */
  verified: boolean;
}

export interface UpdateSnapshot {
  currentVersion: string;
  currentIsCalVer: boolean;
  repository: string;
  repositoryUrl: string;
  settings: UpdateSettings;
  latest: UpdateCandidate | null;
  updateAvailable: boolean;
  dismissed: boolean;
  pendingRestartVersion: string | null;
  lastCheckedAt: string | null;
  lastCheckError: string | null;
  /** "releases" when GitHub releases were used, "tags" when only git tags exist. */
  source: "releases" | "tags" | "unknown";
  checking: boolean;
  installing: boolean;
}

interface SettingsRow {
  auto_check: number;
  include_prerelease: number;
  interval_minutes: number;
  repository: string;
  latest_version: string | null;
  latest_name: string | null;
  latest_notes: string | null;
  latest_url: string | null;
  latest_asset_url: string | null;
  latest_asset_name: string | null;
  latest_sha256: string | null;
  latest_verified: number;
  latest_published_at: string | null;
  latest_prerelease: number;
  last_checked_at: string | null;
  last_check_error: string | null;
  etag: string | null;
  dismissed_version: string | null;
  pending_restart_version: string | null;
  installed_at: string | null;
}

const MIN_INTERVAL = 30;

function row(): SettingsRow {
  const existing = queryOne<SettingsRow>("SELECT * FROM panel_update_settings WHERE id = 1");
  if (existing) return existing;
  run("INSERT INTO panel_update_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING");
  return queryOne<SettingsRow>("SELECT * FROM panel_update_settings WHERE id = 1")!;
}

export function getSettings(): UpdateSettings {
  const settings = row();
  return {
    autoCheck: settings.auto_check === 1,
    includePrerelease: settings.include_prerelease === 1,
    intervalMinutes: Math.max(MIN_INTERVAL, Number(settings.interval_minutes) || 360),
    repository: settings.repository || repositorySlug(),
  };
}

export function saveSettings(patch: Partial<UpdateSettings>): UpdateSettings {
  const current = getSettings();
  const next: UpdateSettings = {
    autoCheck: patch.autoCheck ?? current.autoCheck,
    includePrerelease: patch.includePrerelease ?? current.includePrerelease,
    intervalMinutes:
      patch.intervalMinutes === undefined
        ? current.intervalMinutes
        : Math.min(24 * 60, Math.max(MIN_INTERVAL, Math.round(Number(patch.intervalMinutes) || current.intervalMinutes))),
    repository: current.repository,
  };
  run(
    `UPDATE panel_update_settings
        SET auto_check = ?, include_prerelease = ?, interval_minutes = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = 1`,
    [next.autoCheck ? 1 : 0, next.includePrerelease ? 1 : 0, next.intervalMinutes],
  );
  return next;
}

function candidateFrom(release: GitHubRelease): UpdateCandidate {
  const asset = installerAsset(release);
  const checksum = checksumAsset(release);
  return {
    version: release.version,
    name: release.name || release.tag,
    notes: release.notes,
    url: release.url,
    publishedAt: release.publishedAt,
    prerelease: release.prerelease,
    calver: release.calver || isCalVer(release.version),
    releaseAge: describeReleaseAge(release.version),
    assetName: asset?.name ?? null,
    assetUrl: asset?.url ?? null,
    assetSize: asset && asset.size > 0 ? asset.size : null,
    sha256: null,
    // A checksum file is downloaded and used at install time; advertise only what exists.
    verified: Boolean(checksum),
  };
}

let checking = false;
let lastSource: "releases" | "tags" | "unknown" = "unknown";

/**
 * Fetches the release list and records the newest version.
 *
 * Returns the snapshot for the caller and never throws: a failed check updates `lastCheckError`
 * and leaves the previously known release in place, which is what the banner should show.
 */
export async function checkForUpdates(options: { force?: boolean; actor?: string | null; notifyAdmins?: boolean } = {}): Promise<UpdateSnapshot> {
  if (checking) return snapshot();
  checking = true;
  publishChange();
  try {
    const settings = getSettings();
    const includePrerelease = settings.includePrerelease;
    const { items, source } = await listAvailableVersions({ includePrerelease });
    lastSource = source;
    const best = items.find((release) => isNewerCalVer(release.version, APP_VERSION)) ?? items[0] ?? null;
    const now = new Date().toISOString();
    if (!best) {
      run(
        `UPDATE panel_update_settings SET last_checked_at = ?, last_check_error = NULL,
           latest_version = NULL, latest_name = NULL, latest_notes = NULL, latest_url = NULL,
           latest_asset_url = NULL, latest_asset_name = NULL, latest_sha256 = NULL, latest_verified = 0,
           latest_published_at = NULL, latest_prerelease = 0,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1`,
        [now],
      );
      return snapshot();
    }
    const candidate = candidateFrom(best);
    run(
      `UPDATE panel_update_settings
          SET last_checked_at = ?, last_check_error = NULL,
              latest_version = ?, latest_name = ?, latest_notes = ?, latest_url = ?,
              latest_asset_url = ?, latest_asset_name = ?, latest_sha256 = ?, latest_verified = ?,
              latest_published_at = ?, latest_prerelease = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = 1`,
      [
        now, candidate.version, candidate.name, candidate.notes, candidate.url,
        candidate.assetUrl, candidate.assetName, candidate.sha256, candidate.verified ? 1 : 0,
        candidate.publishedAt, candidate.prerelease ? 1 : 0,
      ],
    );
    // Clearing a dismissal when something newer than the dismissed version appears.
    const dismissed = row().dismissed_version;
    if (dismissed && isNewerCalVer(candidate.version, dismissed)) {
      run("UPDATE panel_update_settings SET dismissed_version = NULL WHERE id = 1");
    }
    if (isNewerCalVer(candidate.version, APP_VERSION) && (options.notifyAdmins ?? true)) {
      notify({
        title: `RSLMC ${candidate.version} is available`,
        body: `You are running ${APP_VERSION}. Open Administration → About to read the release notes and install it.`,
        severity: "info",
        kind: "panel_update",
        link: "/admin/about",
        dedupeKey: `panel-update:${candidate.version}`,
      });
    }
    if (options.actor) {
      recordActivity({
        type: "panel.update_checked", actorName: options.actor, target: "panel",
        metadata: { latest: candidate.version, current: APP_VERSION, source },
      });
    }
    return snapshot();
  } catch (error) {
    const message = error instanceof GitHubError
      ? error.message
      : `Update check failed: ${error instanceof Error ? error.message : String(error)}`;
    run(
      `UPDATE panel_update_settings
          SET last_checked_at = ?, last_check_error = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = 1`,
      [new Date().toISOString(), message],
    );
    return snapshot();
  } finally {
    checking = false;
    publishChange();
  }
}

export function snapshot(): UpdateSnapshot {
  const settings = row();
  const latest: UpdateCandidate | null = settings.latest_version
    ? {
        version: settings.latest_version,
        name: settings.latest_name ?? settings.latest_version,
        notes: settings.latest_notes ?? "",
        url: settings.latest_url ?? repositoryUrl(),
        publishedAt: settings.latest_published_at,
        prerelease: settings.latest_prerelease === 1,
        calver: isCalVer(settings.latest_version),
        releaseAge: describeReleaseAge(settings.latest_version),
        assetName: settings.latest_asset_name,
        assetUrl: settings.latest_asset_url,
        assetSize: null,
        sha256: settings.latest_sha256,
        verified: Boolean(settings.latest_verified),
      }
    : null;
  const available = latest ? isNewerCalVer(latest.version, APP_VERSION) : false;
  return {
    currentVersion: APP_VERSION,
    currentIsCalVer: isCalVer(APP_VERSION),
    repository: settings.repository ?? repositorySlug(),
    repositoryUrl: repositoryUrl(),
    settings: getSettings(),
    latest,
    updateAvailable: available,
    dismissed: Boolean(latest && settings.dismissed_version === latest.version),
    pendingRestartVersion: settings.pending_restart_version,
    lastCheckedAt: settings.last_checked_at,
    lastCheckError: settings.last_check_error,
    source: lastSource === "unknown" && settings.latest_version ? "releases" : lastSource,
    checking,
    installing: isInstalling(),
  };
}

export function dismissUpdate(version: string): void {
  run(
    `UPDATE panel_update_settings SET dismissed_version = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1`,
    [version],
  );
}

/** Called by the installer once the files on disk match `version`. */
export function markInstalled(version: string): void {
  run(
    `UPDATE panel_update_settings
        SET pending_restart_version = ?, installed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            latest_version = NULL, latest_notes = NULL, latest_url = NULL, latest_asset_url = NULL,
            latest_asset_name = NULL, latest_sha256 = NULL, latest_verified = 0, dismissed_version = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = 1`,
    [version],
  );
}

export function clearPendingRestart(): void {
  run("UPDATE panel_update_settings SET pending_restart_version = NULL WHERE id = 1");
}

export function pendingRestartVersion(): string | null {
  return row().pending_restart_version;
}

export function installedAt(): string | null {
  return row().installed_at;
}

/* ------------------------------------------------------------------ */
/* Background watcher                                                  */
/* ------------------------------------------------------------------ */

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Polls on the configured interval. The interval is re-read on every tick so changing it in the UI
 * takes effect without a restart. One immediate check runs 20 s after boot — late enough not to
 * compete with server autostart, early enough that the badge is honest within the first minute.
 */
export function startUpdateWatcher(options: { checkNow?: boolean } = {}): void {
  if (timer) return;
  const tick = () => {
    try {
      const settings = getSettings();
      if (!settings.autoCheck) return;
      void checkForUpdates({ notifyAdmins: true });
    } catch {
      /* settings table missing during a very early boot — the next tick retries */
    }
  };
  // After a restart the previous check's result is stale by definition; refresh it almost at once
  // so Administration → About never shows an empty channel for a whole minute.
  setTimeout(tick, options.checkNow ? 1_200 : 20_000).unref?.();
  timer = setInterval(tick, 60_000);
  timer.unref?.();
}

export function stopUpdateWatcher(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/* ------------------------------------------------------------------ */
/* Live updates to the UI                                              */
/* ------------------------------------------------------------------ */

/** Broadcasts "the update state changed" so open tabs refresh the badge without polling. */
export function publishChange(): void {
  const admins = query<{ id: number }>("SELECT id FROM users WHERE is_root = 1 OR disabled = 0");
  const payload = { type: "panel.update" as const, update: snapshot() };
  for (const admin of admins) bus.publish(`user:${admin.id}`, payload as never);
}

/* ------------------------------------------------------------------ */
/* Install job state (shared with the installer)                       */
/* ------------------------------------------------------------------ */

let installing = false;
export function isInstalling(): boolean {
  return installing;
}
export function setInstalling(value: boolean): void {
  installing = value;
}

export { compareCalVer };

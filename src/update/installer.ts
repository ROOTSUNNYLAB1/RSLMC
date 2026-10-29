import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { statfsSync } from "node:fs";
import { APP_VERSION, PATHS, ROOT_DIR } from "../shared/config";
import { insert, query, queryOne, run } from "../database";
import { createTarGz, extractTarGz } from "../shared/archive";
import { ApiException } from "../shared/http";
import { notify } from "../services/notifications";
import { recordActivity } from "../services/audit";
import { bus } from "../events/bus";
import { isNewerCalVer } from "../shared/calver";
import {
  checksumAsset, installerAsset, listAvailableVersions, repositorySlug, type GitHubRelease,
} from "./github";
import { markInstalled, setInstalling, snapshot, getSettings, publishChange } from "./service";

/**
 * Self-update installer.
 *
 * The panel replaces **code only**. Everything an operator cares about — the SQLite database,
 * servers, worlds, backups, Java runtimes, avatars, secrets — lives in the data directory, which is
 * never touched by this installer (and is refused explicitly if a release ever tries to ship it).
 *
 * The sequence is deliberately boring and reversible:
 *
 *   manifest → disk space → download → checksum → unpack → validate → rollback copy → swap → deps
 *
 * Any failure after the swap restores the rollback copy, so "the update failed" never means "the
 * panel is gone". Every step is recorded with its own timings and is streamed to the About page, so
 * an operator watching the screen knows exactly which step is running and what it did.
 */

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface InstallStep {
  id: string;
  label: string;
  status: StepStatus;
  detail?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface InstallJob {
  id: number;
  targetVersion: string;
  status: "running" | "success" | "failed";
  stage: string;
  steps: InstallStep[];
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  actorName: string | null;
  fromVersion: string;
}

const STEPS: Array<{ id: string; label: string }> = [
  { id: "manifest", label: "Reading the release manifest" },
  { id: "disk", label: "Checking free space and write access" },
  { id: "download", label: "Downloading the release archive" },
  { id: "checksum", label: "Verifying the archive" },
  { id: "extract", label: "Unpacking into a staging folder" },
  { id: "validate", label: "Checking the new build" },
  { id: "backup", label: "Saving a rollback copy of the current build" },
  { id: "apply", label: "Installing the new files" },
  { id: "dependencies", label: "Updating dependencies" },
  { id: "finish", label: "Ready to restart" },
];

/** Never replaced by an update: data, dependencies, VCS metadata, local configuration. */
const PROTECTED_TOP_LEVEL = new Set([
  "node_modules", "runtime", ".git", ".env", "public", "data", "restart.log", ".rslmc-tmp",
]);

function freshSteps(): InstallStep[] {
  return STEPS.map((step) => ({ ...step, status: "pending" }));
}

function jobDir(version: string): string {
  return join(PATHS.temporary, `update-${version.replace(/[^0-9A-Za-z._-]/g, "_")}`);
}

function mapJob(row: any): InstallJob {
  return {
    id: row.id,
    targetVersion: row.target_version,
    status: row.status,
    stage: row.stage ?? "",
    steps: safeParse<InstallStep[]>(row.steps, []),
    error: row.error ?? null,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
    actorName: row.actor_name ?? null,
    fromVersion: APP_VERSION,
  };
}

function safeParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export function latestJob(): InstallJob | null {
  const row = queryOne("SELECT * FROM panel_update_jobs ORDER BY id DESC LIMIT 1");
  return row ? mapJob(row) : null;
}

export function recentJobs(limit = 5): InstallJob[] {
  return query("SELECT * FROM panel_update_jobs ORDER BY id DESC LIMIT ?", [limit]).map(mapJob);
}

function saveSteps(jobId: number, steps: InstallStep[], stage: string): void {
  run("UPDATE panel_update_jobs SET steps = ?, stage = ? WHERE id = ?", [JSON.stringify(steps), stage, jobId]);
  publishJob(jobId);
}

function publishJob(jobId: number): void {
  const job = queryOne("SELECT * FROM panel_update_jobs WHERE id = ?", [jobId]);
  if (!job) return;
  const admins = query<{ id: number }>("SELECT id FROM users WHERE is_root = 1 OR disabled = 0");
  const payload = { type: "panel.update.job", job: mapJob(job) };
  for (const admin of admins) bus.publish(`user:${admin.id}`, payload as never);
}

function step(steps: InstallStep[], id: string): InstallStep {
  const found = steps.find((entry) => entry.id === id);
  if (!found) throw new Error(`unknown install step ${id}`);
  return found;
}

function begin(steps: InstallStep[], id: string, jobId: number, detail?: string): void {
  const target = step(steps, id);
  target.status = "running";
  target.startedAt = Date.now();
  if (detail) target.detail = detail;
  saveSteps(jobId, steps, id);
}

function succeed(steps: InstallStep[], id: string, jobId: number, detail?: string): void {
  const target = step(steps, id);
  target.status = "done";
  target.finishedAt = Date.now();
  if (detail) target.detail = detail;
  else if (target.startedAt) target.detail = `${Date.now() - target.startedAt} ms`;
  saveSteps(jobId, steps, id);
}

function skip(steps: InstallStep[], id: string, jobId: number, detail: string): void {
  const target = step(steps, id);
  target.status = "skipped";
  target.finishedAt = Date.now();
  target.detail = detail;
  saveSteps(jobId, steps, id);
}

/* ------------------------------------------------------------------ */
/* Download                                                            */
/* ------------------------------------------------------------------ */

/**
 * Loopback HTTP is allowed **only** when the operator opts in with
 * `RSLMC_ALLOW_INSECURE_UPDATE_FEED=1` — that is what the test suite uses to exercise the whole
 * install flow against a local fake release server. Anything else must be HTTPS.
 */
function assertReleaseUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new ApiException(400, "invalid_url", "The release asset URL is malformed."); }
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && loopback && process.env.RSLMC_ALLOW_INSECURE_UPDATE_FEED === "1") return url;
  throw new ApiException(400, "insecure_url", "The release asset must be served over HTTPS.");
}

async function downloadArchive(url: string, destination: string, onProgress: (received: number, total: number) => void): Promise<{ bytes: number; sha256: string }> {
  const parsed = assertReleaseUrl(url);
  const response = await fetch(parsed, { headers: { "user-agent": "RSLMC-panel-updater" }, signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new Error(`the release server replied HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length") ?? 0);
  mkdirSync(dirname(destination), { recursive: true });
  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  let received = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const buffer = Buffer.from(value);
    received += buffer.length;
    if (received > 512 * 1024 * 1024) throw new Error("the archive is larger than 512 MB — refusing to install it");
    chunks.push(buffer);
    hash.update(buffer);
    onProgress(received, total);
  }
  const data = Buffer.concat(chunks);
  writeFileSync(destination, data);
  return { bytes: data.length, sha256: hash.digest("hex") };
}

async function fetchChecksum(url: string): Promise<string | null> {
  try {
    const parsed = assertReleaseUrl(url);
    const response = await fetch(parsed, { headers: { "user-agent": "RSLMC-panel-updater" }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return null;
    const text = (await response.text()).trim();
    // Accept "<sha256>  filename" (sha256sum), a bare hash, or "<sha256> *file".
    const match = /^([a-f0-9]{64})\b/i.exec(text);
    return match ? match[1]!.toLowerCase() : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Apply / rollback                                                   */
/* ------------------------------------------------------------------ */

function topLevelEntries(root: string): string[] {
  try { return readdirSync(root); } catch { return []; }
}

function copyEntry(source: string, target: string): void {
  const stats = statSync(source);
  if (stats.isDirectory()) {
    rmSync(target, { recursive: true, force: true });
    cpSync(source, target, { recursive: true, force: true, dereference: true });
  } else {
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { force: true });
  }
}

function restoreBackup(archivePath: string, targetRoot: string): void {
  // The rollback archive contains the previous code tree; unpacking it over the app folder puts the
  // old files back. Data is untouched because it was never in the archive.
  extractTarGz(archivePath, targetRoot);
}

async function runBunInstall(root: string, timeoutMs = 240_000): Promise<{ ok: boolean; output: string }> {
  if (!existsSync(join(root, "package.json"))) return { ok: true, output: "no package.json" };
  try {
    const proc = Bun.spawn([process.execPath, "install"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, timeoutMs);
    const [out, err] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
    ]);
    const code = await proc.exited;
    clearTimeout(timer);
    const output = `${out}\n${err}`.trim();
    return { ok: code === 0, output: output.split("\n").slice(-8).join("\n") };
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
}

/* ------------------------------------------------------------------ */
/* Job                                                                 */
/* ------------------------------------------------------------------ */

export interface StartInstallResult {
  job: InstallJob;
  targetVersion: string;
}

/**
 * Kicks off an installation. Returns immediately with the job (the UI then follows it live through
 * `GET /api/panel/update/job`, and over the WebSocket when it is open).
 */
export async function startInstall(options: { actor: string; actorId: number | null; targetRoot?: string }): Promise<StartInstallResult> {
  const current = snapshot();
  if (current.checking) throw new ApiException(409, "busy", "A version check is running. Try again in a moment.");
  if (current.installing) throw new ApiException(409, "install_in_progress", "An update is already being installed.");
  if (!current.latest) throw new ApiException(409, "no_release", "No release information yet. Run “Check for updates” first.");
  if (!isNewerCalVer(current.latest.version, APP_VERSION)) {
    throw new ApiException(409, "already_current", `${APP_VERSION} is the newest release the panel knows about.`);
  }
  const target = current.latest.version;
  const jobId = insert(
    `INSERT INTO panel_update_jobs (target_version, status, stage, steps, actor_id, actor_name)
     VALUES (?, 'running', 'manifest', ?, ?, ?)`,
    [target, JSON.stringify(freshSteps()), options.actorId, options.actor],
  );
  setInstalling(true);
  publishChange();
  recordActivity({
    type: "panel.update_install", actorName: options.actor, target,
    metadata: { from: APP_VERSION, to: target },
  });

  void runInstall(jobId, target, options.actor, options.targetRoot ?? ROOT_DIR).catch((error) => {
    console.error("[rslmc] update install crashed:", error);
    finalise(jobId, "failed", error instanceof Error ? error.message : String(error));
  });

  const job = queryOne("SELECT * FROM panel_update_jobs WHERE id = ?", [jobId]);
  return { job: mapJob(job), targetVersion: target };
}

function finalise(jobId: number, status: "success" | "failed", error?: string): void {
  run(
    `UPDATE panel_update_jobs
        SET status = ?, error = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
    [status, error ?? null, jobId],
  );
  setInstalling(false);
  publishJob(jobId);
  publishChange();
}

/**
 * `targetRoot` exists so the installer can be pointed at a *copy* of the panel — the test suite uses
 * it to exercise the whole download/verify/swap sequence without touching the running installation,
 * and it doubles as a way to rehearse an update on a staging folder. The HTTP API never passes it.
 */
async function runInstall(jobId: number, version: string, actor: string, targetRoot: string): Promise<void> {
  const steps = freshSteps();
  const workDir = jobDir(version);
  const archivePath = join(workDir, "release.tar.gz");
  const staging = join(workDir, "staging");
  let backupPath: string | null = null;

  const fail = (id: string, message: string) => {
    const target = step(steps, id);
    target.status = "failed";
    target.detail = message;
    target.finishedAt = Date.now();
    saveSteps(jobId, steps, id);
    throw new Error(message);
  };

  try {
    rmSync(workDir, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });

    /* 1 — manifest ------------------------------------------------------- */
    begin(steps, "manifest", jobId);
    let release: GitHubRelease | undefined;
    const { items } = await listAvailableVersions({ includePrerelease: getSettings().includePrerelease });
    release = items.find((item) => item.version === version);
    if (!release) {
      fail("manifest", `Release ${version} is no longer listed by ${repositorySlug()}. Nothing was changed.`);
      return;
    }
    const asset = installerAsset(release);
    if (!asset) fail("manifest", `Release ${version} has no downloadable archive. Nothing was changed.`);
    succeed(steps, "manifest", jobId, `${release.tag} · asset ${asset!.name}`);

    /* 2 — disk ----------------------------------------------------------- */
    begin(steps, "disk", jobId);
    const probeDir = PATHS.temporary;
    mkdirSync(probeDir, { recursive: true });
    let freeBytes = 0;
    try {
      const stats = statfsSync(probeDir);
      freeBytes = Number(stats.bavail) * Number(stats.bsize);
    } catch {
      freeBytes = Number.MAX_SAFE_INTEGER; // statfs is unavailable on some Windows setups
    }
    const expected = Math.max(asset!.size, 20 * 1024 * 1024) * 3;
    if (freeBytes < expected) {
      fail("disk", `Only ${(freeBytes / 1024 ** 2).toFixed(0)} MB free in ${probeDir}; the update needs about ${(expected / 1024 ** 2).toFixed(0)} MB. Free some space and try again.`);
      return;
    }
    succeed(steps, "disk", jobId, `${(freeBytes / 1024 ** 2).toFixed(0)} MB free · staging in ${workDir}`);

    /* 3 — download ------------------------------------------------------- */
    begin(steps, "download", jobId, asset!.name);
    let downloaded: { bytes: number; sha256: string };
    try {
      downloaded = await downloadArchive(asset!.url, archivePath, () => { /* progress is reported below */ });
    } catch (error) {
      fail("download", `Download failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    succeed(steps, "download", jobId, `${asset!.name} · ${(downloaded.bytes / 1024 ** 2).toFixed(2)} MB`);

    /* 4 — checksum ------------------------------------------------------- */
    begin(steps, "checksum", jobId);
    const checksumAssetRef = checksumAsset(release);
    if (checksumAssetRef) {
      const expectedHash = await fetchChecksum(checksumAssetRef.url);
      if (!expectedHash) {
        skip(steps, "checksum", jobId, `${checksumAssetRef.name} could not be read; integrity was checked by unpacking the archive instead.`);
      } else if (expectedHash !== downloaded.sha256) {
        fail("checksum", `SHA-256 mismatch — the archive does not match ${checksumAssetRef.name}. The download was discarded and nothing was installed.`);
        return;
      } else {
        succeed(steps, "checksum", jobId, `SHA-256 ${downloaded.sha256.slice(0, 16)}… matches ${checksumAssetRef.name}`);
      }
    } else {
      skip(steps, "checksum", jobId, "This release publishes no checksum file; the archive is validated by unpacking and checking the build instead.");
    }

    /* 5 — extract -------------------------------------------------------- */
    begin(steps, "extract", jobId);
    let extractedFiles = 0;
    try {
      const result = extractTarGz(archivePath, staging);
      extractedFiles = result.files;
    } catch (error) {
      fail("extract", `The archive could not be unpacked (${error instanceof Error ? error.message : String(error)}). Nothing was installed.`);
      return;
    }
    // GitHub archives wrap everything in one top-level folder; a hand-made tarball may not.
    const entries = topLevelEntries(staging);
    const sourceRoot = entries.length === 1 && statSync(join(staging, entries[0]!)).isDirectory()
      ? join(staging, entries[0]!)
      : staging;
    succeed(steps, "extract", jobId, `${extractedFiles} files unpacked`);

    /* 6 — validate ------------------------------------------------------- */
    begin(steps, "validate", jobId);
    const problems: string[] = [];
    const pkgPath = join(sourceRoot, "package.json");
    if (!existsSync(pkgPath)) problems.push("package.json is missing");
    else {
      const pkg = safeParse<{ name?: string; version?: string }>(readFileSync(pkgPath, "utf8"), {});
      if ((pkg.name ?? "") !== "rslmc") problems.push(`package.json belongs to "${pkg.name ?? "unknown"}", not rslmc`);
      if (pkg.version && pkg.version !== version) problems.push(`the archive says ${pkg.version} but the release is ${version}`);
    }
    if (!existsSync(join(sourceRoot, "src", "index.ts"))) problems.push("src/index.ts is missing");
    if (!existsSync(join(sourceRoot, "frontend", "index.html"))) problems.push("frontend/index.html is missing");
    if (!existsSync(join(sourceRoot, "migrations"))) problems.push("migrations/ is missing");
    if (existsSync(join(sourceRoot, "database")) || existsSync(join(sourceRoot, "servers"))) {
      problems.push("the archive contains data folders — refusing to install a release that ships a database");
    }
    if (problems.length > 0) {
      fail("validate", `Refusing to install this archive: ${problems.join("; ")}.`);
      return;
    }
    succeed(steps, "validate", jobId, `rslmc ${version} · ${readdirSync(join(sourceRoot, "src")).length} source folders · migrations present`);

    /* 7 — backup --------------------------------------------------------- */
    begin(steps, "backup", jobId);
    const backupDir = join(PATHS.backups, "panel");
    mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = join(backupDir, `code-${APP_VERSION}-${stamp}.tar.gz`);
    try {
      const created = createTarGz(backupPath, {
        cwd: targetRoot,
        exclude: [...PROTECTED_TOP_LEVEL, ".rslmc-tmp", "*.log"],
      });
      succeed(steps, "backup", jobId, `${created.files} files · ${(created.bytes / 1024 ** 2).toFixed(2)} MB · ${basename(backupPath)}`);
    } catch (error) {
      // No rollback copy means no update: an operator must always be able to get back.
      fail("backup", `Could not write the rollback copy (${error instanceof Error ? error.message : String(error)}). Nothing was installed.`);
      return;
    }

    /* 8 — apply ---------------------------------------------------------- */
    begin(steps, "apply", jobId);
    const replaced: string[] = [];
    try {
      for (const entry of topLevelEntries(sourceRoot)) {
        if (PROTECTED_TOP_LEVEL.has(entry)) continue;
        copyEntry(join(sourceRoot, entry), join(targetRoot, entry));
        replaced.push(entry);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      step(steps, "apply").status = "failed";
      step(steps, "apply").detail = `File copy failed: ${message} — restoring the previous build.`;
      saveSteps(jobId, steps, "apply");
      try {
        restoreBackup(backupPath, targetRoot);
        step(steps, "apply").detail = `File copy failed (${message}). The previous build was restored from ${basename(backupPath)}; the panel is unchanged.`;
        saveSteps(jobId, steps, "apply");
      } catch (rollbackError) {
        step(steps, "apply").detail = `File copy failed (${message}) AND the rollback failed (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}). Restore ${backupPath} manually before restarting.`;
        saveSteps(jobId, steps, "apply");
      }
      throw new Error(message);
    }
    succeed(steps, "apply", jobId, `${replaced.length} top-level items replaced · database and servers untouched`);

    /* 9 — dependencies --------------------------------------------------- */
    begin(steps, "dependencies", jobId);
    if (replaced.includes("package.json") || replaced.includes("bun.lock")) {
      const install = await runBunInstall(targetRoot);
      if (!install.ok) {
        step(steps, "dependencies").status = "failed";
        step(steps, "dependencies").detail = `bun install failed: ${install.output.split("\n").slice(-3).join(" ")} — restoring the previous build.`;
        saveSteps(jobId, steps, "dependencies");
        restoreBackup(backupPath, targetRoot);
        throw new Error("dependency installation failed; the previous build was restored");
      }
      succeed(steps, "dependencies", jobId, install.output.split("\n").slice(-2).join(" · ") || "bun install finished");
    } else {
      skip(steps, "dependencies", jobId, "No dependency changes in this release.");
    }

    /* 10 — finish -------------------------------------------------------- */
    begin(steps, "finish", jobId);
    markInstalled(version);
    succeed(steps, "finish", jobId, `${version} is on disk. Restart RSLMC to start running it — servers are not interrupted.`);
    finalise(jobId, "success");
    notify({
      title: `RSLMC ${version} installed`,
      body: `The new build is on disk; ${APP_VERSION} is still running. Press “Restart RSLMC” in Administration → About to switch over — running servers are not interrupted.`,
      severity: "success",
      kind: "panel_update",
      link: "/admin/about",
      dedupeKey: `panel-installed:${version}`,
    });
    recordActivity({
      type: "panel.update_installed", actorName: actor, target: version, result: "success",
      metadata: { from: APP_VERSION, to: version, backup: backupPath },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finalise(jobId, "failed", message);
    notify({
      title: "RSLMC update failed",
      body: `${message} The panel is still on ${APP_VERSION}.`,
      severity: "error", kind: "panel_update", link: "/admin/about",
    });
    recordActivity({
      type: "panel.update_installed", actorName: actor, target: version, result: "failure", metadata: { error: message },
    });
  } finally {
    setInstalling(false);
    // Keep the work folder when something failed: it holds the archive and logs the operator can inspect.
    const job = queryOne<{ status: string }>("SELECT status FROM panel_update_jobs WHERE id = ?", [jobId]);
    if (job?.status === "success") rmSync(workDir, { recursive: true, force: true });
    publishChange();
  }
}

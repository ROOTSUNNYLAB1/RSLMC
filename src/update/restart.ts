import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_VERSION, PATHS, ROOT_DIR, PORT } from "../shared/config";
import { insert, query, queryOne, run } from "../database";
import { notify } from "../services/notifications";
import { recordActivity } from "../services/audit";
import { ApiException } from "../shared/http";
import { clearPendingRestart, isInstalling, pendingRestartVersion } from "./service";

/**
 * Panel restart — a full "call it a day" cycle of the panel process, with the Minecraft servers
 * deliberately untouched.
 *
 * How it works:
 *
 *  1. The administrator presses *Restart RSLMC*.
 *  2. A small relauncher (`scripts/restart-panel.ts`) is spawned detached, pointed at our pid. It
 *     inherits the environment, so the new panel lands on the same port and the same data folder.
 *  3. The panel hands every running server over: the relay keeps owning the JVM, we just drop the
 *     socket (`handOffForPanelRestart()`). Nothing is stopped, nothing is marked offline.
 *  4. HTTP/WebSocket close, SQLite is closed cleanly, the process exits.
 *  5. The relauncher waits for the port to become free, starts `src/index.ts` again, and reports the
 *     new pid. A window where the old process is gone but the new one is not up is shown honestly by
 *     the UI ("waiting for the panel"), never as an error the operator caused.
 *  6. On boot the new process finds the restart record, reconnects every relay, and fills in the
 *     timings — so "restart completed in 1.8 s, 3 servers kept running" is measured, not guessed.
 */

export type RestartPhase = "requested" | "stopping" | "relaunching" | "completed" | "failed";

export interface RestartState {
  id: number;
  pid: number;
  port: number;
  kind: "manual" | "update" | "recovery";
  reason: string;
  actor: string | null;
  fromVersion: string;
  toVersion: string;
  phase: RestartPhase;
  requestedAt: number;
  stoppedAt?: number;
  relaunchedAt?: number;
  completedAt?: number;
  newPid?: number;
  serversKept?: number;
  attempts?: number;
  error?: string;
  expiresAt?: number;
}

interface RestartHandlers {
  /** Detach from running servers; must not stop them. */
  handOff: () => { serversKept: number; relayed: number };
  /** Stop accepting requests, close SQLite, exit(0). */
  shutdown: () => Promise<void>;
}

let handlers: RestartHandlers | null = null;

export function registerRestartHandlers(value: RestartHandlers): void {
  handlers = value;
}

function statePath(): string {
  const dir = join(PATHS.data, "runtime");
  try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
  return join(dir, "restart.json");
}

export function readRestartState(): RestartState | null {
  const path = statePath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as RestartState;
    return parsed && typeof parsed.pid === "number" ? parsed : null;
  } catch {
    return null;
  }
}

function writeRestartState(state: RestartState): void {
  const path = statePath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export function patchRestartState(patch: Partial<RestartState>): RestartState | null {
  const current = readRestartState();
  if (!current) return null;
  const next = { ...current, ...patch };
  writeRestartState(next);
  return next;
}

function relauncherPath(): string {
  return join(ROOT_DIR, "scripts", "restart-panel.ts");
}

export interface RestartRequest {
  kind: "manual" | "update" | "recovery";
  reason: string;
  actor: string | null;
  actorId: number | null;
  /** Version the panel will boot into (the installed one, or the target of a pending update). */
  toVersion?: string;
}

/**
 * Starts the restart. Returns the record that the UI polls; the process itself exits ~1 s later.
 * Refuses when an update installation is mid-flight — swapping files while the panel is being
 * restarted is exactly the kind of race that loses data.
 */
export function requestPanelRestart(request: RestartRequest): RestartState {
  if (isInstalling()) {
    throw new ApiException(409, "update_in_progress", "An update is being installed. Wait for it to finish, then restart.");
  }
  const existing = readRestartState();
  if (existing && existing.phase !== "completed" && existing.phase !== "failed" && existing.pid !== process.pid) {
    throw new ApiException(409, "restart_in_progress", "A restart is already in progress.");
  }
  if (!handlers) {
    throw new ApiException(503, "restart_unavailable", "The panel was started in a way that does not allow restarting itself (no shutdown handler registered). Stop and start it manually.");
  }

  const id = insert(
    `INSERT INTO panel_restarts (kind, reason, actor_id, actor_name, from_version, to_version)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [request.kind, request.reason, request.actorId, request.actor, APP_VERSION, request.toVersion ?? APP_VERSION],
  );

  const state: RestartState = {
    id,
    pid: process.pid,
    port: PORT,
    kind: request.kind,
    reason: request.reason,
    actor: request.actor,
    fromVersion: APP_VERSION,
    toVersion: request.toVersion ?? APP_VERSION,
    phase: "requested",
    requestedAt: Date.now(),
  };
  writeRestartState(state);

  spawnRelauncher(state);

  recordActivity({
    type: "panel.restart_requested",
    actorName: request.actor ?? "system",
    target: "panel",
    metadata: { kind: request.kind, reason: request.reason, from: state.fromVersion, to: state.toVersion },
  });

  // Give the HTTP response time to reach the browser before the socket dies.
  setTimeout(() => { void performShutdown(state); }, 900);
  return state;
}

function spawnRelauncher(state: RestartState): void {
  const logDir = PATHS.logs;
  try { mkdirSync(logDir, { recursive: true }); } catch { /* exists */ }
  const logPath = join(logDir, "restart.log");
  try {
    // The relauncher's own output goes to a log file: it must be readable even though the panel
    // that started it is about to disappear (and when the relaunch itself fails, that file is the
    // only place that says why).
    const fd = openSync(logPath, "a");
    try {
      Bun.spawn([process.execPath, relauncherPath(), "--pid", String(state.pid), "--port", String(state.port)], {
        cwd: ROOT_DIR,
        // Detached: the relauncher must outlive the process it is waiting for.
        detached: true,
        stdin: "ignore",
        stdout: fd,
        stderr: fd,
        env: { ...process.env, RSLMC_RESTART_LOG: logPath, RSLMC_RESTART_ID: String(state.id) },
      });
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    patchRestartState({ phase: "failed", error: `Could not start the relauncher: ${error instanceof Error ? error.message : String(error)}` });
    throw new ApiException(500, "restart_failed", "The panel could not start its relauncher process, so it did not restart. Nothing was changed.");
  }
}

async function performShutdown(state: RestartState): Promise<void> {
  if (!handlers) {
    patchRestartState({ phase: "failed", error: "No shutdown handler" });
    return;
  }
  try {
    const handoff = handlers.handOff();
    patchRestartState({ phase: "stopping", stoppedAt: Date.now(), serversKept: handoff.serversKept });
    run("UPDATE panel_restarts SET stopped_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), servers_kept = ? WHERE id = ?", [handoff.serversKept, state.id]);
    console.log(`[rslmc] restarting on request (${state.reason}); ${handoff.serversKept} server(s) keep running.`);
    await handlers.shutdown();
  } catch (error) {
    patchRestartState({ phase: "failed", error: error instanceof Error ? error.message : String(error) });
    console.error("[rslmc] restart failed:", error);
  }
}

/**
 * Called during boot. When the previous process left a restart record, this closes the loop:
 * timings are written to the database, the operator gets a notification with the measured numbers,
 * and a freshly installed update is marked as live.
 */
export function completeRestartOnBoot(serversRunning: number): { restarted: boolean; bootMs: number | null; serversKept: number } {
  const state = readRestartState();
  if (!state || state.pid === process.pid) return { restarted: false, bootMs: null, serversKept: 0 };
  if (state.phase === "completed") return { restarted: false, bootMs: null, serversKept: 0 };

  const bootMs = state.stoppedAt ? Date.now() - state.stoppedAt : null;
  const serversKept = state.serversKept ?? serversRunning;
  run(
    `UPDATE panel_restarts
        SET completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), boot_ms = ?, servers_kept = ?,
            to_version = ?, note = ?
      WHERE id = ?`,
    [bootMs, serversKept, APP_VERSION, state.error ?? null, state.id],
  );
  // A pending "restart to apply the update" only clears once the *new* version is actually running.
  const pending = pendingRestartVersion();
  if (pending && pending === APP_VERSION) clearPendingRestart();

  writeRestartState({
    ...state,
    phase: "completed",
    completedAt: Date.now(),
    newPid: process.pid,
    serversKept,
    toVersion: APP_VERSION,
    expiresAt: Date.now() + 10 * 60_000,
  });
  setTimeout(() => {
    const current = readRestartState();
    if (current?.phase === "completed") { try { rmSync(statePath(), { force: true }); } catch { /* ignore */ } }
  }, 11 * 60_000).unref?.();

  if (state.kind !== "recovery") {
    notify({
      title: "RSLMC restarted",
      body: `${APP_VERSION} is live${bootMs !== null ? ` after ${(bootMs / 1000).toFixed(1)} s` : ""}`
        + `${serversKept > 0 ? `; ${serversKept} server${serversKept === 1 ? "" : "s"} kept running without a restart` : "; no servers were running"}.`,
      severity: "success",
      kind: "panel_restart",
      link: "/admin/about",
      dedupeKey: `panel-restart:${state.id}`,
    });
  }
  recordActivity({
    type: "panel.restarted", actorName: state.actor ?? "system", target: "panel",
    metadata: { bootMs, serversKept, from: state.fromVersion, to: APP_VERSION, kind: state.kind },
  });
  return { restarted: true, bootMs, serversKept };
}

export interface RestartSnapshot {
  current: RestartState | null;
  inProgress: boolean;
  history: Array<{
    id: number; kind: string; reason: string; actorName: string | null; requestedAt: string;
    completedAt: string | null; bootMs: number | null; serversKept: number;
    fromVersion: string; toVersion: string;
  }>;
  pid: number;
  startedAt: number;
}

const BOOTED_AT = Date.now();

export function restartSnapshot(): RestartSnapshot {
  let current = readRestartState();
  const history = query<any>(
    `SELECT id, kind, reason, actor_name, requested_at, completed_at, boot_ms, servers_kept, from_version, to_version
       FROM panel_restarts ORDER BY id DESC LIMIT 8`,
  ).map((row) => ({
    id: row.id,
    kind: row.kind,
    reason: row.reason ?? "",
    actorName: row.actor_name,
    requestedAt: row.requested_at,
    completedAt: row.completed_at,
    bootMs: row.boot_ms,
    serversKept: row.servers_kept ?? 0,
    fromVersion: row.from_version ?? "",
    toVersion: row.to_version ?? "",
  }));
  // Two independent facts say a relaunch is over: the phase reached "completed", or the process the
  // relauncher was told to start is *this* process. The second one matters because the relauncher
  // writes its last status a couple of seconds after the new panel boots, and it can land after the
  // boot has already recorded the completion — which used to leave the UI claiming "a restart is in
  // progress" (and refusing new restarts) until the state file expired.
  const landed = Boolean(current && current.newPid === process.pid);
  if (current && landed && (current.phase === "relaunching" || current.phase === "stopping")) {
    const repaired: RestartState = { ...current, phase: "completed", completedAt: current.completedAt ?? Date.now() };
    try { writeRestartState(repaired); } catch { /* read-only data folder: the UI is still correct below */ }
    current = repaired;
  }
  return {
    current: current && current.pid !== process.pid ? current : null,
    inProgress: Boolean(current && !landed && current.phase !== "completed" && current.phase !== "failed"),
    history,
    pid: process.pid,
    startedAt: BOOTED_AT,
  };
}

export function clearRestartRecord(): void {
  try { rmSync(statePath(), { force: true }); } catch { /* ignore */ }
}

/** Used by the About page to show how long this process has been up. */
export function panelUptimeSeconds(): number {
  return Math.round((Date.now() - BOOTED_AT) / 1000);
}

export function lastRestartRow(): { requested_at: string; boot_ms: number | null } | null {
  return queryOne<{ requested_at: string; boot_ms: number | null }>(
    "SELECT requested_at, boot_ms FROM panel_restarts WHERE completed_at IS NOT NULL ORDER BY id DESC LIMIT 1",
  );
}

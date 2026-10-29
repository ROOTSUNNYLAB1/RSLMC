/**
 * Relauncher for "Restart RSLMC".
 *
 * Started detached by the panel (`src/update/restart.ts`) right before it shuts itself down. This
 * process waits for the old pid to disappear, waits for the HTTP port to be released, then starts
 * `src/index.ts` again with the same environment and working directory. If the first attempt dies
 * immediately it retries once, and it always writes what happened to the restart record — the panel
 * you see next reads that file to say "restarted in 1.8 s".
 *
 * It never touches Minecraft servers: they are owned by their relays, which are their own detached
 * process groups and are unaffected by the panel disappearing for a second.
 *
 *   bun scripts/restart-panel.ts --pid 1234 --port 3000
 */

import { closeSync, existsSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

const ROOT = resolve(dirname(import.meta.dir), ".");
const LOG_PATH = process.env.RSLMC_RESTART_LOG ?? join(ROOT, "restart.log");

function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    const fd = openSync(LOG_PATH, "a");
    try { writeFileSync(fd, line); } finally { closeSync(fd); }
  } catch { /* logging must never break the restart */ }
  try { process.stdout.write(line); } catch { /* detached */ }
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

const oldPid = Number(arg("pid") ?? 0);
const port = Number(arg("port") ?? 0);

function dataDir(): string {
  const explicit = (process.env.RSLMC_DATA_DIR ?? "").trim();
  if (explicit) return resolve(ROOT, explicit);
  // Mirror src/shared/data-location.ts closely enough to find the record: RSLMC_DATA_DIR always wins,
  // then the platform default, then <app>/runtime for an older install.
  if (process.platform === "win32") {
    const programData = process.env.ProgramData;
    const localAppData = process.env.LOCALAPPDATA ?? process.env.APPDATA;
    if (programData && existsSync(join(programData, "RSLMC"))) return join(programData, "RSLMC");
    if (localAppData) return join(localAppData, "RSLMC");
  } else if (process.platform === "darwin") {
    const home = process.env.HOME ?? "";
    return home ? join(home, "Library", "Application Support", "RSLMC") : join(ROOT, "runtime");
  } else if (existsSync("/opt/rslmc")) {
    return "/opt/rslmc";
  }
  return join(ROOT, "runtime");
}

const DATA_DIR = dataDir();
const STATE_PATH = join(DATA_DIR, "runtime", "restart.json");

interface RestartState {
  id: number;
  pid: number;
  port: number;
  phase: string;
  attempts?: number;
  relaunchedAt?: number;
  newPid?: number;
  error?: string;
  fromVersion?: string;
  toVersion?: string;
  completedAt?: number;
  stoppedAt?: number;
  serversKept?: number;
}

function readState(): RestartState | null {
  if (!existsSync(STATE_PATH)) return null;
  try { return JSON.parse(readFileSync(STATE_PATH, "utf8")) as RestartState; } catch { return null; }
}

function patchState(patch: Partial<RestartState>): void {
  const current = readState();
  if (!current) return;
  const tmp = `${STATE_PATH}.tmp`;
  try {
    // The new panel marks the restart completed as soon as it boots, which can happen before the
    // lines below run. Never downgrade that record back to "relaunching": the panel would then keep
    // telling the operator a restart is in progress and refuse to start another one.
    const next = { ...current, ...patch };
    if (current.phase === "completed" && patch.phase && patch.phase !== "completed") {
      next.phase = "completed";
      next.completedAt = current.completedAt;
    }
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, STATE_PATH);
  } catch (error) {
    log(`could not update the restart record: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function alive(pid: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForExit(pid: number, timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(150);
  }
  return !alive(pid);
}

/** The port must be free before the new process binds it, otherwise boot fails with EADDRINUSE. */
async function waitForPortFree(target: number, timeoutMs = 30_000): Promise<boolean> {
  if (!target) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const free = await new Promise<boolean>((done) => {
      let settled = false;
      const finish = (value: boolean) => { if (!settled) { settled = true; done(value); } };
      try {
        const socket = Bun.connect({
          hostname: "127.0.0.1",
          port: target,
          socket: {
            open(s) { s.end(); finish(false); },
            error() { finish(true); },
            data() { /* not used */ },
            close() { /* handled above */ },
          },
        });
        void socket.catch(() => finish(true));
      } catch { finish(true); }
      setTimeout(() => finish(true), 400);
    });
    if (free) return true;
    await sleep(200);
  }
  return false;
}

async function launch(): Promise<number | null> {
  const entry = join(ROOT, "src", "index.ts");
  if (!existsSync(entry)) {
    log(`entry point missing: ${entry}`);
    return null;
  }
  const fd = openSync(LOG_PATH, "a");
  try {
    const child = Bun.spawn([process.execPath, entry], {
      cwd: ROOT,
      detached: true,
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
      env: { ...process.env },
    });
    log(`started RSLMC again as pid ${child.pid}`);
    return child.pid ?? null;
  } catch (error) {
    log(`could not start the panel: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    closeSync(fd);
  }
}

async function main(): Promise<void> {
  const started = Date.now();
  log(`relauncher up (old pid ${oldPid}, port ${port})`);
  patchState({ phase: "relaunching", relaunchedAt: Date.now() });

  if (oldPid) {
    const exited = await waitForExit(oldPid);
    log(exited ? `old process ${oldPid} exited after ${Date.now() - started} ms` : `old process ${oldPid} did not exit in time — continuing anyway`);
  }
  const free = await waitForPortFree(port);
  if (!free) log(`port ${port} is still busy; starting the panel regardless (it will retry binding or report the error)`);

  let newPid = await launch();
  await sleep(2500);

  // A crash on boot (bad config, broken update, port taken) must not leave the operator with a dead
  // panel: retry once, then record the failure where the operator will look.
  if (newPid && !alive(newPid)) {
    log(`the new panel (pid ${newPid}) exited within 2.5 s — retrying once`);
    patchState({ attempts: 2 });
    await sleep(1500);
    newPid = await launch();
    await sleep(2500);
  }

  if (!newPid || !alive(newPid)) {
    patchState({ phase: "failed", error: "The panel did not come back up. See the restart log and the panel log." });
    log("restart failed: the panel is not running");
    process.exit(1);
  }

  patchState({ phase: "relaunching", newPid, relaunchedAt: Date.now() });
  log(`panel is back as pid ${newPid} (relauncher took ${Date.now() - started} ms)`);
  process.exit(0);
}

void main();

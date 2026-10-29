import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/*
 * Regression: the relauncher writes its last status ("relaunching", new pid) about two seconds after
 * the new panel starts. When that landed after the boot had already recorded the run as completed, the
 * record was downgraded and Administration → About claimed "a restart is already in progress" — with
 * the restart button refusing to do anything — until the state file expired eleven minutes later.
 *
 * The snapshot must therefore trust two facts: the phase, and whether this very process is the one the
 * relauncher started.
 */
const DATA_DIR = mkdtempSync(join(tmpdir(), "rslmc-restart-state-"));

let snapshot: typeof import("../src/update/restart");
let stateFile = "";

function writeState(patch: Record<string, unknown>): void {
  const base = {
    id: 1, pid: 999_999, port: 3999, kind: "manual", reason: "test",
    actor: "admin", fromVersion: "2026.10.29", toVersion: "2026.10.29",
    requestedAt: Date.now() - 5_000, expiresAt: Date.now() + 600_000,
  };
  writeFileSync(stateFile, JSON.stringify({ ...base, ...patch }, null, 2));
}

beforeAll(async () => {
  process.env.RSLMC_DATA_DIR = DATA_DIR;
  process.env.RSLMC_PORT = "3999";
  process.env.RSLMC_SERVER_RELAY = "0";
  const database = await import("../src/database");
  const bootstrap = await import("../src/services/bootstrap");
  database.getDb();
  await bootstrap.bootstrap();
  snapshot = await import("../src/update/restart");

  const { PATHS } = await import("../src/shared/config");
  mkdirSync(join(PATHS.data, "runtime"), { recursive: true });
  stateFile = join(PATHS.data, "runtime", "restart.json");
});

afterAll(() => {
  if (existsSync(stateFile)) rmSync(stateFile, { force: true });
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("restart bookkeeping", () => {
  test("a real in-flight restart is reported as in progress", () => {
    writeState({ phase: "stopping" });
    const result = snapshot.restartSnapshot();
    expect(result.inProgress).toBe(true);
    expect(result.current?.phase).toBe("stopping");
  });

  test("a relaunch that is already running this process is not 'in progress'", () => {
    // This is the exact shape the relauncher leaves behind: it named us as the new pid, and its
    // final write arrived after the boot marked the run completed — so the phase says "relaunching".
    writeState({ phase: "relaunching", newPid: process.pid, completedAt: Date.now() - 1_000 });
    const result = snapshot.restartSnapshot();
    expect(result.inProgress).toBe(false);
    expect(result.current?.phase).toBe("completed");
  });

  test("the repaired record is written back, so a reload agrees", () => {
    const onDisk = JSON.parse(readFileSync(stateFile, "utf8")) as { phase: string; newPid: number };
    expect(onDisk.phase).toBe("completed");
    expect(onDisk.newPid).toBe(process.pid);
  });

  test("a failed restart is never reported as in progress", () => {
    writeState({ phase: "failed", error: "the panel did not come back" });
    expect(snapshot.restartSnapshot().inProgress).toBe(false);
  });

  test("no state file means no restart at all", () => {
    rmSync(stateFile, { force: true });
    const result = snapshot.restartSnapshot();
    expect(result.inProgress).toBe(false);
    expect(result.current).toBeNull();
  });
});

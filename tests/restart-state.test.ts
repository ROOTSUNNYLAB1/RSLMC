import { describe, expect, test } from "bun:test";
import { resolveRestartState, type RestartState } from "../src/update/restart";

/*
 * Regression: the relauncher writes its last status ("relaunching", new pid) about two seconds after
 * the new panel starts. When that landed after the boot had already recorded the run as completed, the
 * record was downgraded and Administration → About claimed "a restart is already in progress" — with
 * the restart button refusing to do anything — until the state file expired eleven minutes later.
 *
 * Seen on the first real update (2026.10.29 → 2026.10.29.1). These cases only touch the pure decision
 * function: no database, no environment, no files, so the file cannot affect the rest of the suite.
 */
function state(patch: Partial<RestartState> = {}): RestartState {
  return {
    id: 1, pid: 4242, port: 3999, kind: "manual", reason: "test", actor: "admin",
    fromVersion: "2026.10.29", toVersion: "2026.10.29.1",
    phase: "stopping", requestedAt: Date.now() - 5_000, expiresAt: Date.now() + 600_000,
    ...patch,
  } as RestartState;
}

const THIS_PROCESS = process.pid;

describe("restart bookkeeping", () => {
  test("a real in-flight restart is reported as in progress", () => {
    const result = resolveRestartState(state({ phase: "stopping" }), THIS_PROCESS);
    expect(result.inProgress).toBe(true);
    expect(result.repaired).toBe(false);
  });

  test("a relaunch that is already running this process is not 'in progress'", () => {
    // Exactly what the relauncher leaves behind: it named us as the new pid and its final write
    // arrived after the boot marked the run completed, so the phase still says "relaunching".
    const result = resolveRestartState(
      state({ phase: "relaunching", newPid: THIS_PROCESS, completedAt: Date.now() - 1_000 }),
      THIS_PROCESS,
    );
    expect(result.inProgress).toBe(false);
    expect(result.current?.phase).toBe("completed");
    expect(result.repaired).toBe(true);
  });

  test("a completed restart stays completed and is not rewritten", () => {
    const result = resolveRestartState(state({ phase: "completed", newPid: THIS_PROCESS }), THIS_PROCESS);
    expect(result.inProgress).toBe(false);
    expect(result.repaired).toBe(false);
  });

  test("a failed restart is never reported as in progress", () => {
    const result = resolveRestartState(state({ phase: "failed", error: "did not come back" }), THIS_PROCESS);
    expect(result.inProgress).toBe(false);
    expect(result.current?.phase).toBe("failed");
  });

  test("another process still mid-relaunch keeps the state as it is", () => {
    const result = resolveRestartState(state({ phase: "relaunching", newPid: 999_999 }), THIS_PROCESS);
    expect(result.inProgress).toBe(true);
    expect(result.repaired).toBe(false);
  });

  test("no state file means no restart at all", () => {
    const result = resolveRestartState(null, THIS_PROCESS);
    expect(result).toEqual({ current: null, inProgress: false, repaired: false });
  });
});

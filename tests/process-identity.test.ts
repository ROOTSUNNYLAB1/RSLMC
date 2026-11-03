import { describe, expect, test } from "bun:test";
import { isProcessAlive, isSameProcess, processStartMark } from "../src/processes/orphans";

/*
 * O1 — "is this still the process I recorded?".
 *
 * The panel adopts JVMs it did not spawn and then SIGKILLs the pid it remembered. A pid is not an
 * identity: Linux recycles them, so a kill can land on an unrelated process. The fingerprint below is
 * the kernel's own start time for that pid, which does not change for the life of the process.
 */
describe("process identity", () => {
  test("a live pid has a fingerprint", () => {
    const mark = processStartMark(process.pid);
    expect(mark).not.toBeNull();
    expect(String(mark)).toHaveLength(mark!.length);
  });

  test("the same pid keeps the same fingerprint", () => {
    const first = processStartMark(process.pid);
    const second = processStartMark(process.pid);
    expect(second).toBe(first!);
  });

  test("the recorded process is recognised as itself", () => {
    expect(isSameProcess(process.pid, processStartMark(process.pid))).toBe(true);
  });

  test("a reused pid is NOT recognised — a different start time means a different process", () => {
    // This is exactly what a recycled pid looks like: the number is alive, the fingerprint is not.
    expect(isSameProcess(process.pid, "linux:1")).toBe(false);
  });

  test("a dead pid is never recognised", async () => {
    const child = Bun.spawn(["true"]);
    const pid = child.pid;
    await child.exited;                         // reaped, so the pid is genuinely gone
    expect(isProcessAlive(pid)).toBe(false);
    expect(isSameProcess(pid, processStartMark(pid))).toBe(false);
  });

  test("pid 0 is refused (it would signal the panel's own process group)", () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(1)).toBe(false);
  });

  test("pid 1 and nonsense pids are refused outright", () => {
    expect(processStartMark(1)).toBeNull();
    expect(processStartMark(-5)).toBeNull();
    expect(isSameProcess(0, null)).toBe(false);
  });

  test("no fingerprint recorded → liveness is the only signal (backwards compatible)", () => {
    expect(isSameProcess(process.pid, null)).toBe(true);
    expect(isSameProcess(process.pid, undefined)).toBe(true);
  });
});

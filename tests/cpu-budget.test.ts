import { describe, expect, test } from "bun:test";
import { availableParallelism } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/*
 * "Docker will not start a 400% server on a 2-core box."
 *
 * Reported from a real VPS: allocation 400%, `docker run` answered
 *
 *     range of CPUs is from 0.01 to 2.00, as there are only 2 CPUs available
 *
 * exit code 125, crash recovery restarting every ten seconds, and a console that named no cause. The
 * allocation is a perfectly reasonable request — it is the *grant* that has to be honest. These tests
 * pin the clamp itself, because it is the difference between "starts with less CPU" and "never starts".
 */

process.env.RSLMC_DATA_DIR = process.env.RSLMC_DATA_DIR ?? mkdtempSync(join(tmpdir(), "rslmc-cpu-"));

const budget = await import("../src/resources/cpu-budget");
const { explainCrash } = await import("../src/processes/crash-cause");

describe("CPU budget", () => {
  test("an allocation within the machine is granted unchanged", () => {
    const result = budget.cpuBudget(200, 8);
    expect(result.requestedCores).toBe(2);
    expect(result.grantedCores).toBe(2);
    expect(result.clamped).toBe(false);
    expect(result.note).toBeNull();
    expect(result.source).toBe("docker");
  });

  test("an allocation above the daemon's core count is clamped, and says so", () => {
    const result = budget.cpuBudget(400, 2);
    expect(result.requestedCores).toBe(4);
    expect(result.grantedCores).toBe(2);
    expect(result.clamped).toBe(true);
    // The note has to name both numbers and where the ceiling came from, otherwise it is just noise.
    expect(result.note).toContain("4.00");
    expect(result.note).toContain("2.00");
    expect(result.note).toMatch(/Docker refuses/);
  });

  test("fractional cores never round up past the ceiling", () => {
    // 2.004 cores must become 2.00: rounding up to 2.01 is exactly what the daemon rejects.
    const result = budget.cpuBudget(400, 2.004);
    expect(result.grantedCores).toBe(2);
    expect(result.grantedCores).toBeLessThanOrEqual(2.004);
  });

  test("a ten-percent floor is kept, and Docker's own minimum respected", () => {
    expect(budget.cpuBudget(0, 8).grantedCores).toBe(0.1);
    expect(budget.cpuBudget(10, 8).requestedCores).toBe(0.1);
    // A one-core machine cannot grant 1.5 cores, however politely it is asked.
    expect(budget.cpuBudget(150, 1).grantedCores).toBe(1);
  });

  test("without the daemon's answer, the local core count is used", () => {
    const local = budget.localCpuCores();
    expect(local).toBeGreaterThan(0);
    expect(local).toBeLessThanOrEqual(availableParallelism() + 0.01);
    const result = budget.cpuBudget(100_000, null);
    expect(result.source === "os" || result.source === "unknown").toBe(true);
    expect(result.grantedCores).toBe(Math.min(result.requestedCores, local));
  });
});

describe("a container that Docker refused explains itself", () => {
  const lines = (text: string) => [{ text }];

  test("an over-large CPU request is named, with the real core count", () => {
    const cause = explainCrash({
      lines: lines('docker: Error response from daemon: range of CPUs is from 0.01 to 2.00, as there are only 2 CPUs available'),
      exitCode: 125,
    });
    expect(cause.kind).toBe("invalid_cpu_limit");
    expect(cause.message).toContain("2");
    expect(cause.message).toMatch(/clamp|allocation/);
  });

  test("any other daemon refusal quotes the daemon instead of shrugging", () => {
    const cause = explainCrash({
      lines: lines("docker: Error response from daemon: pull access denied for nope/image, repository does not exist"),
      exitCode: 125,
    });
    expect(cause.kind).toBe("container_rejected");
    expect(cause.message).toContain("pull access denied for nope/image");
  });

  test("an unreachable daemon is not reported as a Minecraft crash", () => {
    const cause = explainCrash({
      lines: lines("docker: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"),
      exitCode: 125,
    });
    expect(cause.kind).toBe("container_unreachable");
    expect(cause.message).toMatch(/not a Minecraft failure/);
  });

  test("a genuine JVM crash still wins over the docker patterns", () => {
    const cause = explainCrash({
      lines: lines("java.lang.OutOfMemoryError: Java heap space\ndocker: Error response from daemon: something"),
      exitCode: 1,
    });
    expect(cause.kind).toBe("out_of_memory");
  });
});

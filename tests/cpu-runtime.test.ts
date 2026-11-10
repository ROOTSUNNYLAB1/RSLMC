import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cpuCapabilities } from "../src/runtime/cpu";
import { explainInstallFailure } from "../src/update/installer";

/*
 * Which Bun build this CPU can run.
 *
 * The failure this covers: Bun installed fine, and then every `bun` process — including the installer's
 * own `bun install` — died with `trap invalid opcode` (SIGILL). The default x86_64 build requires AVX2;
 * the `-baseline` build requires only SSE4.2. Nothing in the panel said so, and the install report was
 * "Installing dependencies failed", which points at the wrong thing entirely.
 *
 * What can be asserted here is the decision, not the CPU: on any given machine the capability report
 * must agree with /proc/cpuinfo, and its recommendation must follow from it.
 */

function cpuinfoHasAvx2(): boolean | null {
  if (process.platform !== "linux") return null;
  try {
    const info = readFileSync("/proc/cpuinfo", "utf8");
    if (!/^flags\s*:/m.test(info)) return null;
    return /\bavx2\b/.test(info);
  } catch {
    return null;
  }
}

describe("the CPU capability report", () => {
  test("it agrees with the kernel about AVX2", () => {
    const report = cpuCapabilities();
    const actual = cpuinfoHasAvx2();
    expect(report.arch).toBe(process.arch);
    if (actual !== null && process.arch === "x64") {
      expect(report.avx2).toBe(actual);
    }
  });

  test("the recommendation follows from AVX2, never from hope", () => {
    const report = cpuCapabilities();
    if (process.arch !== "x64") {
      // ARM has no baseline split, so the question does not apply.
      expect(report.recommendedBunBuild).toBe("unaffected");
      return;
    }
    if (report.avx2 === true) {
      expect(report.recommendedBunBuild).toBe("default");
      expect(report.note).toContain("AVX2");
    } else if (report.avx2 === false) {
      expect(report.recommendedBunBuild).toBe("baseline");
      // The note has to name the symptom an operator will actually see in their logs.
      expect(report.note).toContain("Illegal instruction");
    } else {
      // No flags available: the default is assumed, and the note says what to do if it crashes.
      expect(report.recommendedBunBuild).toBe("default");
      expect(report.note).toContain("Baseline");
    }
  });

  test("the answer is stable and cheap to ask for repeatedly", () => {
    const first = cpuCapabilities();
    const second = cpuCapabilities();
    // Cached object identity: this is read by the System page on every render.
    expect(second).toBe(first);
  });

  test("every report carries a note an operator can act on", () => {
    const report = cpuCapabilities();
    expect(report.note.length).toBeGreaterThan(20);
    expect(report.note.endsWith(".")).toBe(true);
  });
});

describe("a failed dependency install is explained, not just reported", () => {
  /*
   * The update job prints a step result and the operator reads it. "bun install failed: traps: bun[1480]
   * trap invalid opcode" is technically the output, and it sends people to look at their dependencies.
   */
  test("an illegal-instruction trap is named as a CPU/Bun mismatch", () => {
    const realOutput = [
      "Resolving dependencies",
      "traps: bun[1480] trap invalid opcode ip:1a4323c sp:7ffdabb1f550 error:0",
      "Illegal instruction",
    ].join("\n");
    const explained = explainInstallFailure(realOutput);
    expect(explained).toContain("AVX2");
    expect(explained).toContain("baseline");
    expect(explained).toContain("install.sh");
  });

  test("an ordinary failure keeps its own message", () => {
    // A network/registry problem must not be dressed up as a CPU problem.
    expect(explainInstallFailure("error: GET https://registry.npmjs.org/ - connection refused")).toBeNull();
    expect(explainInstallFailure("EACCES: permission denied, mkdir '/opt/rslmc/node_modules'")).toBeNull();
  });
});

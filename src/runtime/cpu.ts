import { readFileSync } from "node:fs";

/*
 * What this CPU can execute.
 *
 * This exists because of a real install failure: Bun was installed, and then every `bun` process died
 * with `trap invalid opcode` — the SIGILL you get when a binary was compiled for an instruction set the
 * CPU does not have. Bun's default x86_64 build needs AVX2; the `-baseline` build only needs SSE4.2.
 * The installer now picks the right one (`install.sh --runtime-plan`), but the panel should be able to
 * answer the same question for itself, so a support conversation does not begin with "run lscpu".
 *
 * Nothing here is guessed: on Linux the flags come from /proc/cpuinfo, on macOS from sysctl, and on a
 * platform with no readable source the answer is `unknown` rather than a hopeful `true`.
 */

export interface CpuCapabilities {
  /** "x64", "arm64", or whatever `process.arch` says. */
  arch: string;
  /** The CPU model, when the platform reports one. */
  model: string | null;
  /** `true`/`false` when it could be read, `null` when this platform does not say. */
  avx2: boolean | null;
  sse42: boolean | null;
  /**
   * Which Bun build this machine should run. `baseline` means: any Bun process here needs the
   * `bun-linux-x64-baseline` build, and a `trap invalid opcode` in the logs is this, not a bug.
   */
  recommendedBunBuild: "default" | "baseline" | "unaffected";
  /** One line an operator can act on. */
  note: string;
}

/** CPU flags as the kernel reports them, or null when this platform does not expose them. */
export function cpuFlags(): string[] | null {
  if (process.platform === "linux") {
    try {
      const info = readFileSync("/proc/cpuinfo", "utf8");
      const flags = new Set<string>();
      for (const match of info.matchAll(/^flags\s*:\s*(.+)$/gm)) {
        for (const flag of match[1].trim().split(/\s+/)) flags.add(flag.toLowerCase());
      }
      return flags.size > 0 ? [...flags] : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    try {
      const result = Bun.spawnSync({ cmd: ["sysctl", "-n", "machdep.cpu.leaf7_features"], stdout: "pipe", stderr: "pipe", timeout: 4000 });
      const text = result.stdout?.toString().trim();
      return text ? text.toLowerCase().split(/\s+/) : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function cpuModel(): string | null {
  if (process.platform === "linux") {
    try {
      const info = readFileSync("/proc/cpuinfo", "utf8");
      const match = info.match(/^model name\s*:\s*(.+)$/m);
      return match ? match[1].trim() : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    try {
      const result = Bun.spawnSync({ cmd: ["sysctl", "-n", "machdep.cpu.brand_string"], stdout: "pipe", stderr: "pipe", timeout: 4000 });
      return result.stdout?.toString().trim() || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Cached: this is read on every System/About render and the answer cannot change while we run. */
let cached: CpuCapabilities | null = null;

export function cpuCapabilities(): CpuCapabilities {
  if (cached) return cached;
  const flags = cpuFlags();
  const arch = process.arch;
  const model = cpuModel();
  // Only x86_64 has a baseline build; ARM machines are unaffected by the AVX2 question entirely.
  if (arch !== "x64") {
    cached = {
      arch, model,
      avx2: null, sse42: null,
      recommendedBunBuild: "unaffected",
      note: `${arch} does not use the AVX2 build split — Bun's build for this architecture is the only one.`,
    };
    return cached;
  }
  if (!flags) {
    cached = {
      arch, model,
      avx2: null, sse42: null,
      recommendedBunBuild: "default",
      note: "This platform does not report CPU flags, so the installer's default Bun build is assumed. If bun ever dies with 'Illegal instruction', install the Baseline build from github.com/oven-sh/bun/releases.",
    };
    return cached;
  }
  const avx2 = flags.includes("avx2");
  const sse42 = flags.includes("sse4_2") || flags.includes("sse4.2");
  cached = {
    arch, model, avx2, sse42,
    recommendedBunBuild: avx2 ? "default" : "baseline",
    note: avx2
      ? "This CPU supports AVX2, so Bun's default x86_64 build runs here."
      : `This CPU has no AVX2, so Bun's default x86_64 build would crash with "Illegal instruction".${sse42 ? " The Baseline build (SSE4.2) is the one to use — install.sh picks it automatically." : " Even the Baseline build needs SSE4.2, which this CPU does not report — check the CPU model before installing."}`,
  };
  return cached;
}

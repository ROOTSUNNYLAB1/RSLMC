import { availableParallelism } from "node:os";
import { readFileSync } from "node:fs";

/*
 * How much CPU a server can actually be given.
 *
 * Docker refuses `--cpus` larger than the cores its daemon can see:
 *
 *     docker: Error response from daemon: range of CPUs is from 0.01 to 2.00,
 *     as there are only 2 CPUs available
 *
 * Exit code 125, no JVM, no console output from the server — a server that "crashed" for a reason that
 * had nothing to do with Minecraft. Allocations are expressed in CPU-percent (400% = four cores), which
 * is a perfectly reasonable thing to type on a 2-core machine; it is the *grant* that has to be honest.
 *
 * So the number that reaches `--cpus` is clamped to what the machine has, and the difference is reported
 * rather than hidden: a preview line, a console line at start, and the server's resource note all say
 * what was asked for and what was granted.
 */

export interface CpuBudget {
  /** Cores the daemon (or this process, when the daemon is unknown) can offer. */
  hostCores: number;
  /** Cores the allocation asks for: 400% → 4.00. */
  requestedCores: number;
  /** Cores that will really be passed to `--cpus`. */
  grantedCores: number;
  /** True when the request exceeded the machine and had to be reduced. */
  clamped: boolean;
  /** One sentence for the console/UI when clamped, null otherwise. */
  note: string | null;
  /** Where `hostCores` came from, so the UI can say it truthfully. */
  source: "docker" | "os" | "unknown";
}

/** Docker's own lower bound, and its two-decimal resolution. */
const MIN_CORES = 0.01;
const MAX_CORES = 1024;

/**
 * Reads a cgroup v2 `cpu.max` quota ("200000 100000" → 2 cores).
 *
 * A panel that is itself containerised sees the host's core count from `os.cpus()` but is throttled to
 * its own quota; without this the clamp would promise a server CPU that the panel's container will
 * never get to use.
 */
function cgroupCpuCores(): number | null {
  if (process.platform !== "linux") return null;
  try {
    const raw = readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim();
    const [quotaPart, periodPart] = raw.split(/\s+/);
    if (!quotaPart || quotaPart === "max") return null;
    const quota = Number(quotaPart);
    const period = Number(periodPart) || 100_000;
    if (!Number.isFinite(quota) || quota <= 0) return null;
    return quota / period;
  } catch {
    return null;
  }
}

/**
 * The cores this process could use, without asking Docker.
 *
 * `availableParallelism()` respects CPU affinity and (on current runtimes) a cgroup CPU quota, which is
 * what makes it the right default over `os.cpus().length` — that one reports every core on the box even
 * inside a one-core container.
 */
export function localCpuCores(): number {
  let cores = 1;
  try { cores = availableParallelism(); } catch { /* older runtime */ }
  const quota = cgroupCpuCores();
  if (quota !== null) cores = Math.min(cores, quota);
  return Math.max(MIN_CORES, Number(cores.toFixed(2)));
}

function round2(value: number): number {
  // Floor, never round up: 2.004 cores must not become 2.01 and get refused by the daemon.
  return Math.floor(value * 100) / 100;
}

/**
 * Clamps an allocation to what can really be granted.
 *
 * @param cpuPercent the stored allocation (100 = one core-equivalent)
 * @param hostCores  the daemon's view of the machine (`docker info` NCPU), when known — it is the
 *                   authority for what `--cpus` will accept, so it wins over the local guess
 */
export function cpuBudget(cpuPercent: number, hostCores?: number | null): CpuBudget {
  const requestedCores = Math.min(MAX_CORES, Math.max(MIN_CORES, Number((Math.max(10, cpuPercent) / 100).toFixed(2))));
  const known = Number(hostCores);
  const fromDaemon = Number.isFinite(known) && known > 0;
  const available = fromDaemon ? known : localCpuCores();
  const source: CpuBudget["source"] = fromDaemon ? "docker" : available > 0 ? "os" : "unknown";

  // The daemon takes two decimals; a 1.5-core machine must grant 1.50, not 1.49 because of float noise.
  const ceiling = Math.max(MIN_CORES, round2(available));
  const grantedCores = Math.min(requestedCores, ceiling);
  const clamped = grantedCores < requestedCores;

  const note = clamped
    ? `CPU ${requestedCores.toFixed(2)} cores requested, but this ${source === "docker" ? "Docker daemon" : "machine"} has `
      + `${ceiling.toFixed(2)} — granting ${grantedCores.toFixed(2)}. Docker refuses a larger --cpus value, so the `
      + "allocation is capped instead of failing to start. Raise it on a bigger host, or lower it in Settings → Resources."
    : null;

  return { hostCores: ceiling, requestedCores, grantedCores, clamped, note, source };
}

import { readFileSync, existsSync } from "node:fs";
import { readUsage } from "./cgroups";

export interface ProcessSnapshot {
  pid: number;
  rssBytes: number | null;
  virtualBytes: number | null;
  cpuPercent: number | null;
  threads: number | null;
  source: string;
}

const CLK_TCK = 100;

interface ProcSample { jiffies: number; at: number; cpuPercent: number | null }

/** CPU-time baseline per pid. Only sampleProcess() advances it (see the comment there). */
const samples = new Map<number, ProcSample>();

function readLinuxStat(pid: number): { jiffies: number; rssPages: number; vsize: number; threads: number } | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = raw.lastIndexOf(")");
    const fields = raw.slice(end + 2).split(" ");
    const utime = Number(fields[11]);
    const stime = Number(fields[12]);
    const cutime = Number(fields[13]);
    const cstime = Number(fields[14]);
    const vsize = Number(fields[20]);
    const rssPages = Number(fields[21]);
    const threads = Number(fields[17]);
    return { jiffies: utime + stime + cutime + cstime, rssPages, vsize, threads };
  } catch {
    return null;
  }
}

/**
 * Windows has no /proc, so the raw numbers come from PowerShell. `Get-Process` exposes the same
 * information we need: working set, private bytes, thread count and **cumulative CPU seconds**
 * (`.CPU`), which is the direct equivalent of the utime+stime jiffies on Linux — a delta between
 * two reads divided by elapsed wall-clock time is the real utilisation.
 *
 * Returns null when the pid is gone or PowerShell is unavailable.
 */
interface WindowsSample { at: number; cpuSeconds: number | null; rssBytes: number | null; vsize: number | null; threads: number | null }

// Spawning PowerShell costs a couple of hundred milliseconds, and the UI polls server state far
// more often than the 3s metrics tick. Cache briefly so a poll does not fork a shell every time.
const windowsCache = new Map<number, WindowsSample>();
const WINDOWS_CACHE_MS = 2_000;

function readWindowsProcess(pid: number): { cpuSeconds: number | null; rssBytes: number | null; vsize: number | null; threads: number | null } | null {
  const cached = windowsCache.get(pid);
  if (cached && Date.now() - cached.at < WINDOWS_CACHE_MS) return cached;
  try {
    const result = Bun.spawnSync([
      "powershell", "-NoProfile", "-NonInteractive", "-Command",
      `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue
if ($p) { "$($p.WorkingSet64)|$($p.PrivateMemorySize64)|$($p.Threads.Count)|$($p.CPU)" }`,
    ], { stdout: "pipe", stderr: "ignore", timeout: 5_000 });
    const text = result.stdout.toString().trim();
    if (!text) return null;
    // Get-Process prints an empty string for properties it cannot read (a process owned by another
    // user), and Number("") is 0 — which would freeze the CPU reading at 0 %. Treat it as unknown.
    const num = (value: string | undefined): number | null => {
      const parsed = Number((value ?? "").trim());
      return (value ?? "").trim() !== "" && Number.isFinite(parsed) ? parsed : null;
    };
    const [wsRaw, privRaw, threadsRaw, cpuRaw] = text.split("|");
    const ws = num(wsRaw);
    if (ws === null) return null;
    const priv = num(privRaw);
    const threads = num(threadsRaw);
    const cpu = num(cpuRaw);
    const sample: WindowsSample = {
      at: Date.now(),
      cpuSeconds: cpu,
      rssBytes: ws,
      vsize: priv,
      threads: threads === null ? null : Math.round(threads),
    };
    windowsCache.set(pid, sample);
    return sample;
  } catch {
    return null;
  }
}

function lastCpu(pid: number): number | null {
  return samples.get(pid)?.cpuPercent ?? null;
}

/**
 * Converts a cumulative CPU counter into a percentage over the elapsed window, then stores the
 * new baseline. 100% means one fully used core on both Linux and Windows, matching how the
 * allocation is expressed in the panel (200% = two cores).
 */
function advanceBaseline(pid: number, jiffies: number, now: number): number | null {
  const before = samples.get(pid);
  let cpuPercent: number | null = null;
  if (before && now > before.at) {
    const deltaJiffies = Math.max(0, jiffies - before.jiffies);
    cpuPercent = (deltaJiffies / CLK_TCK / ((now - before.at) / 1000)) * 100;
  }
  samples.set(pid, { jiffies, at: now, cpuPercent });
  return cpuPercent;
}

function snapshotFrom(cpuPercent: number | null): ProcessSnapshot["cpuPercent"] {
  return cpuPercent === null ? null : Number(cpuPercent.toFixed(2));
}

/**
 * Read-only sample: memory, threads and the last measured CPU. It deliberately does **not** touch
 * the CPU baseline — display paths (API reads, page polls) used to call the delta version and
 * reset the window every couple of seconds, which made a busy JVM report 0.0%.
 */
export function peekProcess(pid: number): ProcessSnapshot {
  if (process.platform === "linux") {
    const stat = readLinuxStat(pid);
    if (!stat) return { pid, rssBytes: null, virtualBytes: null, cpuPercent: lastCpu(pid), threads: null, source: "unavailable" };
    return {
      pid,
      rssBytes: stat.rssPages * 4096,
      virtualBytes: stat.vsize,
      cpuPercent: lastCpu(pid),
      threads: stat.threads,
      source: "/proc",
    };
  }
  if (process.platform === "win32") {
    const info = readWindowsProcess(pid);
    if (!info) return { pid, rssBytes: null, virtualBytes: null, cpuPercent: lastCpu(pid), threads: null, source: "unavailable" };
    return {
      pid,
      rssBytes: info.rssBytes,
      virtualBytes: info.vsize,
      cpuPercent: lastCpu(pid),
      threads: info.threads,
      source: "Get-Process",
    };
  }
  return { pid, rssBytes: null, virtualBytes: null, cpuPercent: lastCpu(pid), threads: null, source: "unavailable" };
}

/**
 * Per-process resource sampling with a CPU delta. CPU percentages describe observed usage
 * (CPU-time consumed between two samples over wall-clock time), never an allocation.
 *
 * Call this from the metrics ticker only.
 */
export function sampleProcess(pid: number, _previous: ProcessSnapshot | null = null): ProcessSnapshot {
  if (process.platform === "linux") {
    const stat = readLinuxStat(pid);
    if (!stat) return { pid, rssBytes: null, virtualBytes: null, cpuPercent: null, threads: null, source: "unavailable" };
    const cpuPercent = advanceBaseline(pid, stat.jiffies, Date.now());
    return {
      pid,
      rssBytes: stat.rssPages * 4096,
      virtualBytes: stat.vsize,
      cpuPercent: snapshotFrom(cpuPercent),
      threads: stat.threads,
      source: "/proc",
    };
  }

  if (process.platform === "win32") {
    const info = readWindowsProcess(pid);
    if (!info) return { pid, rssBytes: null, virtualBytes: null, cpuPercent: null, threads: null, source: "unavailable" };
    const cpuPercent = info.cpuSeconds === null
      ? null
      : advanceBaseline(pid, Math.round(info.cpuSeconds * CLK_TCK), Date.now());
    return {
      pid,
      rssBytes: info.rssBytes,
      virtualBytes: info.vsize,
      cpuPercent: snapshotFrom(cpuPercent),
      threads: info.threads,
      source: "Get-Process",
    };
  }

  return { pid, rssBytes: null, virtualBytes: null, cpuPercent: null, threads: null, source: "unavailable" };
}

export function resetProcessSamples(pid: number): void {
  samples.delete(pid);
  windowsCache.delete(pid);
}

export function listChildPids(pid: number): number[] {
  if (process.platform !== "linux") return [];
  try {
    const result = Bun.spawnSync(["sh", "-c", `pgrep -P ${Number(pid)} 2>/dev/null`], { stdout: "pipe", stderr: "ignore" });
    return result.stdout.toString().trim().split("\n").filter(Boolean).map(Number).filter(Number.isFinite);
  } catch {
    return [];
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

/**
 * Resident working set of the server's cgroup (all native memory, not just the Java heap).
 *
 * File page cache is excluded: reading a Paper jar leaves tens of megabytes charged to the cgroup
 * that the kernel would evict in a heartbeat, and counting it made an idle server look like it was
 * using its whole allocation.
 */
export function cgroupMemory(serverId: number): number | null {
  if (process.platform !== "linux") return null;
  return readUsage(serverId).memoryBytes;
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

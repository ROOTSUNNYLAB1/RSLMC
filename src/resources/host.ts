import { readFileSync, existsSync } from "node:fs";
import { cpus, totalmem, freemem, loadavg, uptime, release, platform, arch } from "node:os";
import { statfsSync } from "node:fs";
import { PATHS } from "../shared/config";
import { directorySize } from "../shared/platform";
import type { NodeStats } from "../shared/types";

let lastCpuSample: { idle: number; total: number; at: number } | null = null;
let lastCpuPercent = 0;
/** /proc/stat counters are cumulative; a delta over a few microseconds is pure noise. */
const MIN_CPU_SAMPLE_MS = 750;

function readProcStat(): { idle: number; total: number } | null {
  if (process.platform !== "linux") return null;
  try {
    const line = readFileSync("/proc/stat", "utf8").split("\n")[0];
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = (parts[3] ?? 0) + (parts[4] ?? 0);
    const total = parts.reduce((sum, value) => sum + value, 0);
    return { idle, total };
  } catch {
    return null;
  }
}

/** Host CPU utilisation measured from successive /proc/stat samples. */
export function hostCpuPercent(): number {
  const loadEstimate = () => {
    // Non-Linux (or too-frequent) fallback: load average normalised by cores.
    const [load] = loadavg();
    return Math.max(0, Math.min(100, (load / Math.max(1, cpus().length)) * 100));
  };
  const sample = readProcStat();
  if (!sample) return loadEstimate();

  const now = Date.now();
  const previous = lastCpuSample;
  if (!previous) {
    lastCpuSample = { ...sample, at: now };
    return loadEstimate();
  }
  // Reuse the last real measurement when we are asked again too soon to be meaningful.
  if (now - previous.at < MIN_CPU_SAMPLE_MS) return lastCpuPercent;

  const totalDelta = sample.total - previous.total;
  const idleDelta = sample.idle - previous.idle;
  lastCpuSample = { ...sample, at: now };
  if (totalDelta <= 0) return lastCpuPercent;
  lastCpuPercent = Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
  return lastCpuPercent;
}

export function diskUsage(path = PATHS.data): { totalBytes: number; usedBytes: number; freeBytes: number } {
  try {
    const stats = statfsSync(path);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    return { totalBytes, usedBytes: totalBytes - freeBytes, freeBytes };
  } catch {
    return { totalBytes: 0, usedBytes: 0, freeBytes: 0 };
  }
}

export function hostStats(): NodeStats {
  const total = totalmem();
  const free = freemem();
  const disk = diskUsage();
  return {
    os: `${platform()} ${release()}`,
    arch: arch(),
    cpuCores: cpus().length,
    cpuUsagePercent: Number(hostCpuPercent().toFixed(1)),
    memoryTotalBytes: total,
    memoryUsedBytes: total - free,
    diskTotalBytes: disk.totalBytes,
    diskUsedBytes: disk.usedBytes,
    loadAverage: loadavg() as [number, number, number],
    javaVersion: systemJavaVersion(),
    bunVersion: Bun.version,
    uptimeSeconds: Math.floor(uptime()),
    agents: { cgroups: false, privileged: false },
  };
}

let cachedSystemJava: string | null | undefined;
export function systemJavaVersion(): string | null {
  if (cachedSystemJava !== undefined) return cachedSystemJava;
  cachedSystemJava = null;
  try {
    const result = Bun.spawnSync(["java", "-version"], { stdout: "pipe", stderr: "pipe" });
    const text = `${result.stdout.toString()}${result.stderr.toString()}`;
    const match = /(?:openjdk|java) version "([^"]+)"/i.exec(text);
    if (match) cachedSystemJava = match[1]!;
  } catch {
    cachedSystemJava = null;
  }
  return cachedSystemJava;
}

export function directorySizeSync(path: string): number {
  // Pure-JS recursive walk: works on Windows, where `du` does not exist.
  return directorySize(path);
}

export function tcpConnections(port: number): number {
  if (process.platform !== "linux") return 0;
  try {
    const result = Bun.spawnSync(["sh", "-c", `ss -Htn state established '( sport = :${Number(port)} )' 2>/dev/null | wc -l`], {
      stdout: "pipe", stderr: "ignore",
    });
    return Number(result.stdout.toString().trim()) || 0;
  } catch {
    return 0;
  }
}

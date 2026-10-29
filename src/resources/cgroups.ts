import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PATHS } from "../shared/config";

/**
 * Real Linux enforcement via cgroup v2.
 *
 * RSLMC never runs the panel as root. Instead it installs a *narrowly scoped* root-owned
 * helper once (via the configured `sudo` prefix) and calls it with strictly validated
 * arguments. The helper can only create/limit/attach/remove RSLMC cgroups — it is not a
 * general privileged shell.
 */

const CGROUP_ROOT = "/sys/fs/cgroup";
// Installed root-owned binary-ish script. It is never writable by the panel user: the
// generated copy is staged in the data directory, then installed with `install -o root`.
const HELPER_PATH = "/usr/local/sbin/rslmc-cgroup-helper";
const STAGED_HELPER_PATH = join(PATHS.temporary, "rslmc-cgroup-helper.sh");

const HELPER_SOURCE = `#!/bin/sh
# RSLMC privileged cgroup helper (generated). Scoped to /sys/fs/cgroup/rslmc only.
set -eu
ROOT=/sys/fs/cgroup/rslmc

# Delegation is two-level on cgroup v2: the parent must expose the controllers to us,
# and we must enable them on our own subtree before child cgroups show memory.max/cpu.max.
enable_controllers() {
  for parent in /sys/fs/cgroup "$ROOT"; do
    for controller in memory cpu pids; do
      if [ -f "$parent/cgroup.controllers" ] && grep -qw "$controller" "$parent/cgroup.controllers"; then
        if ! grep -qw "$controller" "$parent/cgroup.subtree_control" 2>/dev/null; then
          echo "+$controller" > "$parent/cgroup.subtree_control" 2>/dev/null || true
        fi
      fi
    done
  done
}

case "\${1:-}" in
  init)
    mkdir -p "$ROOT"
    enable_controllers
    chmod 755 "$ROOT"
    ;;
  create)
    # create <name> <memBytes|0> <cpuQuotaPercent|0> <pidsMax|0>
    name="$2"; mem="$3"; cpu="$4"; pids="$5"
    case "$name" in *[!a-zA-Z0-9_-]*) echo "invalid name" >&2; exit 2;; esac
    case "$mem$cpu$pids" in *[!0-9]*) echo "invalid numeric argument" >&2; exit 2;; esac
    mkdir -p "$ROOT"
    enable_controllers
    mkdir -p "$ROOT/$name"
    if [ "$mem" != "0" ]; then echo "$mem" > "$ROOT/$name/memory.max"; fi
    if [ "$cpu" != "0" ]; then
      quota=$(( cpu * 1000 )); period=100000
      echo "$quota $period" > "$ROOT/$name/cpu.max"
    fi
    if [ "$pids" != "0" ]; then echo "$pids" > "$ROOT/$name/pids.max"; fi
    ;;
  attach)
    # attach <name> <pid>
    name="$2"; pid="$3"
    case "$name" in *[!a-zA-Z0-9_-]*) echo "invalid name" >&2; exit 2;; esac
    case "$pid" in *[!0-9]*) echo "invalid pid" >&2; exit 2;; esac
    echo "$pid" > "$ROOT/$name/cgroup.procs"
    ;;
  kill)
    name="$2"
    case "$name" in *[!a-zA-Z0-9_-]*) echo "invalid name" >&2; exit 2;; esac
    [ -f "$ROOT/$name/cgroup.kill" ] && echo "1" > "$ROOT/$name/cgroup.kill" || true
    ;;
  remove)
    name="$2"
    case "$name" in *[!a-zA-Z0-9_-]*) echo "invalid name" >&2; exit 2;; esac
    [ -d "$ROOT/$name" ] && rmdir "$ROOT/$name" 2>/dev/null || true
    ;;
  *) echo "unknown command" >&2; exit 2;;
esac
`;

export interface CgroupCapabilities {
  supported: boolean;
  privileged: boolean;
  version: 1 | 2 | 0;
  reason: string;
  helperInstalled: boolean;
  sudoPrefix: string | null;
}

let cached: CgroupCapabilities | null = null;

function sudo(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const result = Bun.spawnSync(["sudo", "-n", ...args], { stdout: "pipe", stderr: "pipe", timeout: 8000 });
    return { ok: result.exitCode === 0, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  } catch (err) {
    return { ok: false, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
}

export function detectCgroups(force = false): CgroupCapabilities {
  if (cached && !force) return cached;

  if (process.platform !== "linux") {
    cached = {
      supported: false, privileged: false, version: 0, helperInstalled: false, sudoPrefix: null,
      reason: "cgroup enforcement is Linux-only. Windows uses Job Objects where available; RSLMC reports memory/CPU limits as advisory on this host.",
    };
    return cached;
  }

  const v2 = existsSync("/sys/fs/cgroup/cgroup.controllers");
  if (!v2) {
    cached = {
      supported: false, privileged: false, version: 1, helperInstalled: false, sudoPrefix: null,
      reason: "cgroup v2 unified hierarchy was not detected; RSLMC will not claim enforced limits.",
    };
    return cached;
  }

  const canSudo = sudo(["-n", "true"]).ok || sudo(["true"]).ok || sudo(["-n", "mkdir", "-p", "/sys/fs/cgroup/rslmc-probe"]).ok;
  // Probe with a real operation rather than trusting `sudo -n true`.
  const probe = sudo(["-n", "mkdir", "-p", "/sys/fs/cgroup/rslmc-probe"]);
  if (probe.ok) sudo(["-n", "rmdir", "/sys/fs/cgroup/rslmc-probe"]);

  const privileged = probe.ok;
  const helperInstalled = existsSync(HELPER_PATH);

  cached = {
    supported: true,
    privileged,
    version: 2,
    helperInstalled,
    sudoPrefix: privileged ? "sudo -n" : null,
    reason: privileged
      ? "cgroup v2 with a scoped sudo helper — memory and CPU limits are enforced by the kernel."
      : "cgroup v2 detected but RSLMC cannot obtain write access. Limits are advisory only until the helper is installed as root.",
  };
  return cached;
}

export function installHelper(): { ok: boolean; message: string } {
  const capabilities = detectCgroups(true);
  if (capabilities.version !== 2) return { ok: false, message: capabilities.reason };
  if (!capabilities.privileged) {
    return { ok: false, message: "Root access is required to install the cgroup helper. Run: sudo bun run scripts/install-cgroup-helper.ts" };
  }
  if (!existsSync(PATHS.temporary)) mkdirSync(PATHS.temporary, { recursive: true, mode: 0o750 });
  writeFileSync(STAGED_HELPER_PATH, HELPER_SOURCE, { mode: 0o700 });
  try { chmodSync(STAGED_HELPER_PATH, 0o700); } catch { /* ignore */ }
  const install = sudo(["-n", "install", "-m", "0700", "-o", "root", "-g", "root", STAGED_HELPER_PATH, HELPER_PATH]);
  if (!install.ok) return { ok: false, message: `Failed to install helper: ${install.stderr.trim()}` };
  const init = sudo(["-n", HELPER_PATH, "init"]);
  if (!init.ok) return { ok: false, message: `Helper initialisation failed: ${init.stderr.trim()}` };
  cached = null;
  return { ok: true, message: "Privileged cgroup helper installed." };
}

export function cgroupNameFor(serverId: number): string {
  return `rslmc-server-${serverId}`;
}

export function cgroupPath(serverId: number): string {
  return `/sys/fs/cgroup/rslmc/${cgroupNameFor(serverId)}`;
}

export interface LimitRequest {
  serverId: number;
  memoryBytes: number;
  cpuPercent: number;
}

function helperIsCurrent(): boolean {
  if (!existsSync(HELPER_PATH)) return false;
  try {
    return readFileSync(HELPER_PATH, "utf8") === HELPER_SOURCE;
  } catch {
    return false;
  }
}

export function applyLimits(request: LimitRequest): { ok: boolean; message: string } {
  const capabilities = detectCgroups();
  if (!capabilities.privileged) return { ok: false, message: capabilities.reason };
  if (!helperIsCurrent()) {
    const installed = installHelper();
    if (!installed.ok) return installed;
    if (!detectCgroups(true).privileged) return { ok: false, message: "Helper installed but sudo access is still unavailable." };
  }
  const result = sudo([
    "-n", HELPER_PATH, "create",
    cgroupNameFor(request.serverId),
    String(Math.max(0, Math.floor(request.memoryBytes))),
    String(Math.max(0, Math.floor(request.cpuPercent))),
    "4096",
  ]);
  return result.ok
    ? { ok: true, message: "cgroup limits applied" }
    : { ok: false, message: result.stderr.trim() || "failed to apply cgroup limits" };
}

export function attachProcess(serverId: number, pid: number): { ok: boolean; message: string } {
  const capabilities = detectCgroups();
  if (!capabilities.privileged) return { ok: false, message: capabilities.reason };
  const result = sudo(["-n", HELPER_PATH, "attach", cgroupNameFor(serverId), String(pid)]);
  return result.ok ? { ok: true, message: "process attached to cgroup" } : { ok: false, message: result.stderr.trim() };
}

export function killCgroup(serverId: number): boolean {
  if (!detectCgroups().privileged) return false;
  return sudo(["-n", HELPER_PATH, "kill", cgroupNameFor(serverId)]).ok;
}

export function removeCgroup(serverId: number): void {
  if (!detectCgroups().privileged) return;
  sudo(["-n", HELPER_PATH, "remove", cgroupNameFor(serverId)]);
}

export interface CgroupUsage {
  /**
   * Working set: `memory.current` minus the file page cache the kernel can reclaim at any time.
   *
   * `memory.current` on its own counts every page the cgroup touched — reading a 50 MB Paper jar,
   * the libraries and the world files leaves those pages charged to the server, so a 1 GB server
   * looked like it was using "all the RAM" while the JVM heap sat half empty. Page cache is not
   * resident pressure (the kernel evicts it before it ever hits `memory.max`), so reported usage
   * uses the same definition systemd calls the working set.
   */
  memoryBytes: number | null;
  /** Raw `memory.current`, page cache included. Shown separately so nothing is hidden. */
  memoryCurrentBytes: number | null;
  /** Reclaimable page cache attributed to the cgroup (`memory.stat: file`). */
  memoryCacheBytes: number | null;
  cpuUsageMicros: number | null;
  oomKills: number | null;
}

function readNumber(path: string): number | null {
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (raw === "max") return null;
    const value = Number(raw.split("\n")[0]?.trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function readMemoryStatValue(raw: string, key: string): number | null {
  for (const line of raw.split("\n")) {
    const [name, value] = line.trim().split(/\s+/);
    if (name === key) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  return null;
}

export function readUsage(serverId: number): CgroupUsage {
  const base = cgroupPath(serverId);
  const cpuStat = existsSync(join(base, "cpu.stat"))
    ? readFileSync(join(base, "cpu.stat"), "utf8")
    : "";
  const memoryStat = existsSync(join(base, "memory.stat"))
    ? readFileSync(join(base, "memory.stat"), "utf8")
    : "";
  const usageMatch = /usage_usec (\d+)/.exec(cpuStat);
  const oomMatch = /oom_kill (\d+)/.exec(cpuStat);
  const current = readNumber(join(base, "memory.current"));
  const cache = readMemoryStatValue(memoryStat, "file");
  const workingSet = current === null ? null : Math.max(0, current - (cache ?? 0));
  return {
    memoryBytes: workingSet,
    memoryCurrentBytes: current,
    memoryCacheBytes: cache,
    cpuUsageMicros: usageMatch ? Number(usageMatch[1]) : null,
    oomKills: oomMatch ? Number(oomMatch[1]) : null,
  };
}

/**
 * Decides which memory number to trust.
 *
 * A cgroup is the better source when it is really accounting for the process: it excludes pages the
 * JVM shares with everything else and it is what `memory.max` is enforced against. But a container
 * can hand out a cgroupfs where the memory controller is only half-delegated: the files exist, the
 * limits look right, and `memory.current` still reads a few hundred kilobytes for a process using a
 * gigabyte. Reporting that number would be a fake metric, so the process RSS wins whenever the two
 * disagree by more than 4× — and the caller is told which one it got, so the UI can say so too.
 */
export function resolveMemoryUsage(
  cgroupBytes: number | null | undefined,
  rssBytes: number | null | undefined,
): { bytes: number; source: "cgroup" | "/proc" | "none"; cgroupTrusted: boolean } {
  const cg = typeof cgroupBytes === "number" && Number.isFinite(cgroupBytes) && cgroupBytes >= 0 ? cgroupBytes : null;
  const rss = typeof rssBytes === "number" && Number.isFinite(rssBytes) && rssBytes > 0 ? rssBytes : null;
  if (cg === null && rss === null) return { bytes: 0, source: "none", cgroupTrusted: false };
  if (cg === null) return { bytes: rss!, source: "/proc", cgroupTrusted: false };
  // A cgroup reading of exactly zero with no process sample is not "0 bytes of memory": it means
  // there is nothing to measure yet.
  if (cg === 0 && rss === null) return { bytes: 0, source: "none", cgroupTrusted: false };
  if (rss === null) return { bytes: cg, source: "cgroup", cgroupTrusted: true };
  // A cgroup working set can legitimately be smaller than RSS (shared libraries, page cache), but
  // never by an order of magnitude for the process it is supposed to contain.
  const plausible = cg * 4 >= rss;
  return plausible
    ? { bytes: cg, source: "cgroup", cgroupTrusted: true }
    : { bytes: rss, source: "/proc", cgroupTrusted: false };
}

export function resetCapabilityCache(): void {
  cached = null;
}

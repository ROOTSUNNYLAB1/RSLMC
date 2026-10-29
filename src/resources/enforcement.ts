import { existsSync, readFileSync } from "node:fs";
import type { EnforcementLevel, ResourceEnforcement } from "../shared/types";
import { detectCgroups } from "./cgroups";
import { hostPlatform } from "../shared/config";

/**
 * RSLMC is deliberately honest about what it can enforce.
 *  - enforced  : the kernel/OS stops the process from exceeding the limit.
 *  - partial   : a real mechanism exists but does not cover every memory/CPU source.
 *  - advisory  : we pass the value to Java or store it as a target, but cannot enforce it.
 *  - unsupported: not offered on this host.
 */

export interface DiskQuotaSupport {
  enforced: boolean;
  mechanism: string;
  note: string;
}

export function detectDiskQuota(target = "/"): DiskQuotaSupport {
  if (process.platform !== "linux") {
    return {
      enforced: false,
      mechanism: "none",
      note: process.platform === "win32"
        ? "Windows NTFS quotas are per-user, not per-directory. RSLMC tracks and reports directory size but cannot enforce a per-server disk quota on this host."
        : "Disk quotas are not supported on this platform.",
    };
  }
  try {
    const mounts = readFileSync("/proc/mounts", "utf8").split("\n");
    const relevant = mounts.filter((line) => line.includes(" " + target + " ") || line.includes("/sys/fs/cgroup"));
    const prjQuota = mounts.some((line) => /prjquota/.test(line));
    if (prjQuota) {
      return {
        enforced: true,
        mechanism: "project quota",
        note: "The host filesystem reports project-quota support. RSLMC records the configured quota; applying project IDs is handled by the host administrator.",
      };
    }
    if (relevant.length === 0) {
      return { enforced: false, mechanism: "none", note: "Could not determine quota support for this filesystem." };
    }
    return {
      enforced: false,
      mechanism: "none",
      note: "No project-quota filesystem detected. The configured disk value is a soft limit used for warnings; usage is measured from the real server directory.",
    };
  } catch {
    return { enforced: false, mechanism: "none", note: "Filesystem quota support could not be inspected." };
  }
}

export function describeEnforcement(capabilities = detectCgroups()): ResourceEnforcement {
  const platform = hostPlatform();
  const memory: ResourceEnforcement["memory"] = capabilities.privileged
    ? {
        level: "enforced",
        mechanism: "cgroup v2 memory.max",
        note: "Total process memory (heap + native) is capped by the kernel for the server's cgroup. RSLMC sets -Xms/-Xmx slightly below the cap (up to 256 MB reserved for metaspace, code cache, GC and threads) so the JVM stays inside it.",
      }
    : {
        level: "advisory",
        mechanism: "-Xms/-Xmx only",
        note: platform.os === "windows"
          ? "Windows Job Object limits are not applied by this build, so only the Java heap is constrained. Native memory can exceed the configured value."
          : "RSLMC does not have privileged cgroup access on this host, so only the Java heap is constrained.",
      };

  const cpu: ResourceEnforcement["cpu"] = capabilities.privileged
    ? {
        level: "enforced",
        mechanism: "cgroup v2 cpu.max",
        note: "Allocation is expressed in CPU-capacity percent (100% = one core-equivalent). The kernel throttles the cgroup to that quota.",
      }
    : {
        level: "advisory",
        mechanism: "none",
        note: "CPU percentages are recorded as an allocation target; no kernel quota is applied on this host.",
      };

  const diskSupport = detectDiskQuota();
  const disk: ResourceEnforcement["disk"] = diskSupport.enforced
    ? { level: "partial", mechanism: diskSupport.mechanism, note: diskSupport.note }
    : { level: "advisory", mechanism: "usage tracking", note: diskSupport.note };

  return { memory, cpu, disk };
}

export function enforcementBadge(level: EnforcementLevel): string {
  return level === "enforced" ? "Enforced" : level === "partial" ? "Partially enforced" : level === "advisory" ? "Advisory only" : "Unsupported";
}

export function systemdAvailable(): boolean {
  return existsSync("/run/systemd/system");
}

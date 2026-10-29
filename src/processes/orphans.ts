import { readdirSync, readFileSync, readlinkSync } from "node:fs";

/**
 * Detects Java processes that belong to a server directory but were **not** started by the panel.
 *
 * Why this exists: the panel's process table lives in memory. If the panel process is restarted,
 * killed or suspended (a Codespace sleeping, a container restart, `bun src/index.ts` run twice)
 * while a server is running, the Java process can survive as an orphan. The panel then shows the
 * last persisted status — often `error` after a failed reinstall — while that orphan keeps a port
 * bound and burns CPU. That combination ("Installation failed" next to 176 % CPU) is a lie, so the
 * manager adopts or reports every such process instead of ignoring it.
 */

export interface ForeignProcess {
  pid: number;
  startedAt: number;
  command: string;
}

const CACHE_MS = 4_000;
let cached: { at: number; list: ForeignProcess[] } | null = null;

function normalise(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function isJavaExe(pid: number): boolean | null {
  try {
    const exe = readlinkSync(`/proc/${pid}/exe`);
    const base = exe.split(/[\\/]/).pop() ?? "";
    return /^java(w)?(\.exe)?$/.test(base);
  } catch { return null; } // not readable (permissions) — fall back to the cmdline heuristic
}

function readCwdLinux(pid: number): string | null {
  try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return null; }
}

function readStartMsLinux(pid: number): number {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 22 is starttime in clock ticks since boot; skip the "(comm)" field which may contain spaces.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const ticks = Number(fields[19] ?? 0);
    const statFile = readFileSync("/proc/stat", "utf8");
    const btime = Number(/btime\s+(\d+)/.exec(statFile)?.[1] ?? 0) * 1000;
    const hertz = 100; // USER_HZ is 100 on every Linux ABI the panel ships for.
    return btime > 0 && ticks > 0 ? btime + (ticks * 1000) / hertz : Date.now();
  } catch {
    return Date.now();
  }
}

function listLinux(): ForeignProcess[] {
  const out: ForeignProcess[] = [];
  let entries: string[] = [];
  try { entries = readdirSync("/proc"); } catch { return out; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let command = "";
    try {
      command = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    } catch { continue; }
    if (!command) continue;
    const lower = command.toLowerCase();
    if (!/(^|[\s/\\])java(w)?(\.exe)?(\s|$)/.test(lower)) continue;
    // The cmdline check alone also matches shell wrappers that merely *mention* a java command
    // (`bash -c "cd … && java -jar server.jar"`). /proc/<pid>/exe is authoritative.
    if (isJavaExe(pid) === false) continue;
    // The panel spawns Java with cwd = server directory and a relative `-jar server.jar`, so the
    // command line alone does not identify the server. Carry the working directory as part of the
    // match key; on Windows the launch command uses an absolute jar path instead.
    const cwd = readCwdLinux(pid);
    out.push({ pid, startedAt: readStartMsLinux(pid), command: cwd ? `${command} cwd=${cwd}` : command });
  }
  return out;
}

/**
 * One PowerShell call for every Java process. `CreationDate` is converted to epoch milliseconds
 * inside PowerShell so the panel never has to parse a locale date string.
 */
function listWindows(): ForeignProcess[] {
  const script = [
    "Get-CimInstance Win32_Process -Filter \"Name='java.exe' or Name='javaw.exe'\" |",
    "ForEach-Object { \"$($_.ProcessId)|$([int64]([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds())|$($_.CommandLine)\" }",
  ].join(" ");
  const result = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], {
    stdout: "pipe", stderr: "ignore",
  });
  const text = result.success ? result.stdout.toString() : "";
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    const [pidText, startedText, ...rest] = line.split("|");
    const pid = Number(pidText);
    if (!Number.isFinite(pid) || pid === process.pid) return [];
    return [{ pid, startedAt: Number(startedText) || Date.now(), command: rest.join("|") }];
  });
}

function list(): ForeignProcess[] {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.list;
  let list: ForeignProcess[] = [];
  try {
    list = process.platform === "win32" ? listWindows() : listLinux();
  } catch {
    list = [];
  }
  cached = { at: Date.now(), list };
  return list;
}

export function invalidateForeignProcessCache(): void {
  cached = null;
}

/** Finds a live JVM whose command line points at this server directory. */
export function findJavaProcessForDirectory(directory: string): ForeignProcess | null {
  const needle = normalise(directory);
  for (const candidate of list()) {
    const command = normalise(candidate.command);
    const inCwd = command.includes(`cwd=${needle}`);
    const inCommand = command.includes(needle);
    if (!inCwd && !inCommand) continue;
    // Only JVMs started with a jar / args file — never a stray `java -version` or the panel itself.
    if (/(^|\s)(-jar|@user_jvm_args|unix_args|win_args|\/server\.jar)/.test(command) || inCwd) return candidate;
  }
  return null;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

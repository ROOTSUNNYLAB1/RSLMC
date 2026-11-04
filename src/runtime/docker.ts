import { existsSync } from "node:fs";

/*
 * Docker, the way the panel uses it.
 *
 * A server can run two ways: as a JVM started by the panel (standalone), or inside a Docker
 * container. The container is not a wrapper around the same process — it is a separate cgroup, which
 * is the whole reason to offer it: memory and CPU are enforced by the kernel whether or not the host
 * has the RSLMC cgroup helper installed, and the server's files stay where they were, bind-mounted
 * into the container, so the file manager, backups, properties editor and world tools keep working
 * untouched.
 *
 * Everything here shells out to the real `docker` CLI and reports what it actually said. There is no
 * "pretend Docker" path: when the CLI or the daemon is missing, the panel says so and the wizard will
 * not offer the option.
 */

export interface DockerInfo {
  /** True only when the CLI answered `docker info` — i.e. a daemon is reachable. */
  available: boolean;
  version: string | null;
  apiVersion: string | null;
  /** `overlay2`, `vfs`, … — decides whether a per-container disk quota can be enforced. */
  storageDriver: string | null;
  cgroupVersion: string | null;
  /** Docker's own default runtime, so the UI can say what will execute the container. */
  runtimes: string[];
  /** Whether `--storage-opt size=` can actually be honoured on this driver. */
  diskQuota: boolean;
  /** Human explanation when something is missing, e.g. the CLI is not installed. */
  reason: string | null;
  cliPath: string | null;
  checkedAt: number;
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
  /** True when the binary itself could not be executed. */
  missing: boolean;
}

/**
 * Where the CLI might be. Read on every probe rather than at import time, so an operator (or a test)
 * can point `RSLMC_DOCKER_BIN` at a specific binary without restarting the panel.
 */
function dockerCandidates(): string[] {
  return [
    process.env.RSLMC_DOCKER_BIN,
    "docker",
    "/usr/bin/docker",
    "/usr/local/bin/docker",
    "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
  ].filter((value): value is string => Boolean(value));
}

let cachedCli: string | null = null;
let cachedInfo: DockerInfo | null = null;
let cacheAt = 0;
const INFO_TTL_MS = 15_000;

/**
 * Runs a Docker command with a timeout and no shell.
 *
 * `stdin: "ignore"` matters: `docker` reading a terminal it does not have is how a panel hangs on a
 * dead daemon instead of reporting it.
 */
export function dockerCommand(args: string[], timeoutMs = 20_000): CommandResult {
  // An explicit override wins over probing: an operator who points RSLMC_DOCKER_BIN at a binary
  // means it, and a failure must be reported for that binary rather than silently using PATH.
  const bin = process.env.RSLMC_DOCKER_BIN ?? cachedCli ?? dockerCandidates().find((candidate) => {
    if (candidate.includes("/") || candidate.includes("\\")) return existsSync(candidate);
    return true;                                    // bare name: let PATH decide
  }) ?? "docker";
  try {
    const result = Bun.spawnSync([bin, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env, DOCKER_CLI_HINTS: "false" },
      timeout: timeoutMs,
    });
    return {
      ok: result.exitCode === 0,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      code: result.exitCode ?? -1,
      missing: false,
    };
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      code: -1,
      missing: true,
    };
  }
}

/**
 * The same command, awaited instead of blocking.
 *
 * `docker stats` samples twice and takes ~2 s on a real daemon. Running that with spawnSync freezes the
 * whole panel for those two seconds — the page stops rendering, the ping looks slow, websockets stall.
 * Anything that can take measurable time goes through this one.
 */
export async function dockerCommandAsync(args: string[], timeoutMs = 20_000): Promise<CommandResult> {
  const bin = process.env.RSLMC_DOCKER_BIN ?? dockerBin();
  try {
    const child = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout as ReadableStream<Uint8Array>).text(),
      new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    ]);
    const code = await child.exited;
    clearTimeout(timer);
    return { ok: code === 0, stdout, stderr, code, missing: false };
  } catch (error) {
    return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error), code: -1, missing: true };
  }
}

/**
 * The executable to use when spawning a *long-lived* container.
 *
 * Resolved once, from the same candidates as `dockerCommand`, so the launch plan and the probes can
 * never disagree about which binary exists.
 */
export function dockerBin(): string {
  if (process.env.RSLMC_DOCKER_BIN) cachedCli = process.env.RSLMC_DOCKER_BIN;
  if (cachedCli) return cachedCli;
  for (const candidate of dockerCandidates()) {
    if (candidate.includes("/") || candidate.includes("\\")) {
      if (existsSync(candidate)) { cachedCli = candidate; return candidate; }
      continue;
    }
    const probe = dockerCommandFor(candidate, ["--version"], 8000);
    if (probe.ok) { cachedCli = candidate; return candidate; }
  }
  cachedCli = "docker";
  return cachedCli;
}

function dockerCommandFor(bin: string, args: string[], timeoutMs: number): CommandResult {
  try {
    const result = Bun.spawnSync([bin, ...args], {
      stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: timeoutMs,
    });
    return { ok: result.exitCode === 0, stdout: result.stdout.toString(), stderr: result.stderr.toString(), code: result.exitCode ?? -1, missing: false };
  } catch (error) {
    return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error), code: -1, missing: true };
  }
}

/** Storage drivers that can enforce a per-container size. Anything else is reported as unable to. */
const QUOTA_DRIVERS = new Set(["btrfs", "zfs", "devicemapper"]);

/** Probes the daemon. Cached for 15 s so a page load does not fork a dozen processes. */
export function probeDocker(force = false): DockerInfo {
  const now = Date.now();
  if (!force && cachedInfo && now - cacheAt < INFO_TTL_MS) return cachedInfo;

  const version = dockerCommand(["version", "--format", "{{.Server.Version}}"], 12_000);
  const cliVersion = dockerCommand(["version", "--format", "{{.Client.Version}}"], 12_000);

  if (version.missing && cliVersion.missing) {
    cachedInfo = emptyInfo("The Docker CLI was not found on this machine. Install Docker Engine (Linux) or Docker Desktop (Windows/macOS) to create container servers.");
    cacheAt = now;
    return cachedInfo;
  }

  const info = dockerCommand(["info", "--format", "{{json .}}"], 15_000);
  if (!info.ok) {
    const stderr = `${info.stderr}${info.stdout}`.trim();
    cachedInfo = emptyInfo(
      "Docker is installed but its daemon is not answering. "
      + `${firstLine(stderr) || "docker info failed"}`
      + " Start the daemon (systemctl start docker / launch Docker Desktop) and press Check again.",
      cliVersion.ok ? cliVersion.stdout.trim() : null,
    );
    cacheAt = now;
    return cachedInfo;
  }

  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(info.stdout) as Record<string, unknown>; } catch { /* older daemons print a table */ }

  /*
   * A daemon that refuses the connection still makes `docker info` exit 0: it prints a full JSON
   * document with empty fields and the real error inside `ServerErrors`. Trusting the exit code is how
   * a panel ends up offering "Docker" while every container command fails with "permission denied".
   */
  const serverErrors = Array.isArray(parsed.ServerErrors) ? parsed.ServerErrors.map(String).filter(Boolean) : [];
  const serverVersion = String(parsed.ServerVersion ?? "").trim();
  if (serverErrors.length > 0 || !serverVersion) {
    const detail = serverErrors[0] ?? "the daemon returned no server version";
    const hint = /permission denied/i.test(detail)
      ? " This account is not allowed to use the Docker socket — add it to the `docker` group (Linux) and restart the panel."
      : "";
    cachedInfo = emptyInfo(`Docker is installed but the daemon refused the request: ${detail}.${hint}`, cliVersion.ok ? cliVersion.stdout.trim() : null);
    cacheAt = now;
    return cachedInfo;
  }

  const storageDriver = String(parsed.Driver ?? "").trim() || null;
  const cgroupVersion = parsed.CgroupVersion ? String(parsed.CgroupVersion) : null;
  const runtimesRaw = parsed.Runtimes as Record<string, unknown> | undefined;
  const runtimes = runtimesRaw ? Object.keys(runtimesRaw) : [];

  /*
   * Disk quota support is not "the driver supports storage-opt" in the abstract: overlay2 only
   * enforces it on a filesystem that carries project quotas (xfs with prjquota). The panel probes by
   * asking the daemon to create a throwaway container with a size option and reading the answer —
   * guessing from the driver name alone reported quotas as available on machines that reject them.
   */
  const diskQuota = probeDiskQuota(storageDriver);

  cachedInfo = {
    available: true,
    version: version.ok ? version.stdout.trim() : null,
    apiVersion: parsed.APIVersion ? String(parsed.APIVersion) : null,
    storageDriver,
    cgroupVersion,
    runtimes,
    diskQuota,
    reason: null,
    cliPath: dockerBin(),
    checkedAt: now,
  };
  cacheAt = now;
  return cachedInfo;
}

function emptyInfo(reason: string, version: string | null = null): DockerInfo {
  return {
    available: false, version, apiVersion: null, storageDriver: null, cgroupVersion: null,
    runtimes: [], diskQuota: false, reason, cliPath: cachedCli, checkedAt: Date.now(),
  };
}

function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).filter(Boolean)[0] ?? "";
}

/**
 * Asks the daemon directly whether it will honour `--storage-opt size=`. A create that is rejected
 * with "storage-opt is not supported" is the only reliable negative answer; anything else (no image,
 * daemon busy) leaves the question open, so it reports `false` and the UI says "not enforced" rather
 * than promising a limit that may silently not exist.
 */
function probeDiskQuota(storageDriver: string | null): boolean {
  if (!storageDriver) return false;
  if (QUOTA_DRIVERS.has(storageDriver)) return true;
  if (storageDriver !== "overlay2") return false;
  const probe = dockerCommand(
    ["create", "--name", "rslmc-quota-probe", "--storage-opt", "size=1G", "scratch"],
    15_000,
  );
  dockerCommand(["rm", "-f", "rslmc-quota-probe"], 10_000);
  if (probe.ok) {
    // Accepted: the driver really did take the option.
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Images                                                              */
/* ------------------------------------------------------------------ */

export interface ImageRow {
  reference: string;
  id: string;
  sizeBytes: number;
  /** True when this exact reference is present locally. */
  local: boolean;
}

/** Every local image, newest tag first, for the "already pulled" list. */
export function listImages(): ImageRow[] {
  const result = dockerCommand(["image", "ls", "--format", "{{json .}}"], 20_000);
  if (!result.ok) return [];
  const rows: ImageRow[] = [];
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const repository = String(parsed.Repository ?? "");
      const tag = String(parsed.Tag ?? "");
      if (!repository || repository === "<none>") continue;
      rows.push({
        reference: `${repository}:${tag}`,
        id: String(parsed.ID ?? ""),
        sizeBytes: parseSize(String(parsed.Size ?? "0B")),
        local: true,
      });
    } catch { /* a line the CLI printed that is not JSON: skip it */ }
  }
  return rows;
}

export function imagePresent(reference: string): boolean {
  const result = dockerCommand(["image", "inspect", "--format", "{{.Id}}", reference], 15_000);
  return result.ok && result.stdout.trim().length > 0;
}

/**
 * Parses Docker's human sizes into bytes.
 *
 * The CLI prints both decimal ("1.24GB", used by `docker image ls`) and binary ("463.6MiB", used by
 * `docker stats`) units, and treating "MiB" as unparseable is how the memory panel ended up showing a
 * flat zero for a container that was using half a gigabyte.
 */
export function parseSize(text: string): number {
  const match = /^([\d.]+)\s*([KMGTP])?(i)?B?$/i.exec(text.trim());
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return 0;
  const unit = (match[2] ?? "").toUpperCase();
  const binary = Boolean(match[3]);
  if (!unit) return Math.round(value);
  // Docker's binary units are MiB/GiB (1024-based); its decimal ones are MB/GB (1000-based).
  const base = binary ? 1024 : 1000;
  const power = unit === "K" ? 1 : unit === "M" ? 2 : unit === "G" ? 3 : unit === "T" ? 4 : 5;
  return Math.round(value * base ** power);
}

/**
 * Pulls an image, streaming progress. Used by the wizard ("prepare image") and before the first
 * start of a container server, so a slow pull is visible in the console instead of looking like a
 * server that never starts.
 */
export async function pullImage(
  reference: string,
  onProgress?: (line: string) => void,
  timeoutMs = 15 * 60_000,
): Promise<{ ok: boolean; message: string }> {
  const bin = dockerBin();
  try {
    const process_ = Bun.spawn([bin, "pull", reference], {
      stdout: "pipe", stderr: "pipe", stdin: "ignore",
    });
    const decoder = new TextDecoder();
    let last = "";
    const reader = async (stream: ReadableStream<Uint8Array> | null) => {
      if (!stream) return;
      for await (const chunk of stream) {
        const text = decoder.decode(chunk as Uint8Array, { stream: true });
        for (const raw of text.split(/[\r\n]+/)) {
          const line = raw.trim();
          if (!line) continue;
          last = line;
          onProgress?.(line);
        }
      }
    };
    const timer = setTimeout(() => { try { process_.kill(); } catch { /* gone */ } }, timeoutMs);
    await Promise.all([reader(process_.stdout as ReadableStream<Uint8Array>), reader(process_.stderr as ReadableStream<Uint8Array>)]);
    const code = await process_.exited;
    clearTimeout(timer);
    if (code === 0) return { ok: true, message: `${reference} is ready.` };
    return { ok: false, message: last || `docker pull exited with code ${code}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/* ------------------------------------------------------------------ */
/* Containers                                                          */
/* ------------------------------------------------------------------ */

export interface ContainerState {
  name: string;
  exists: boolean;
  running: boolean;
  status: string;
  pid: number | null;
  exitCode: number | null;
  startedAt: string | null;
  image: string | null;
}

/** One `docker inspect`, no format guessing: the full JSON, parsed defensively. */
export function inspectContainer(name: string): ContainerState {
  const result = dockerCommand(["inspect", name], 15_000);
  const empty: ContainerState = {
    name, exists: false, running: false, status: "missing", pid: null, exitCode: null, startedAt: null, image: null,
  };
  if (!result.ok) return empty;
  try {
    const parsed = JSON.parse(result.stdout) as Array<Record<string, any>>;
    const first = parsed[0];
    if (!first) return empty;
    const state = first.State ?? {};
    return {
      name,
      exists: true,
      running: Boolean(state.Running),
      status: String(state.Status ?? (state.Running ? "running" : "exited")),
      pid: typeof state.Pid === "number" && state.Pid > 0 ? state.Pid : null,
      exitCode: typeof state.ExitCode === "number" ? state.ExitCode : null,
      startedAt: state.StartedAt ?? null,
      image: first.Config?.Image ?? null,
    };
  } catch {
    return empty;
  }
}

export interface ContainerStats {
  /** CPU percentage of one core, as Docker computes it. */
  cpuPercent: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
  pids: number | null;
}

/**
 * Container metrics from the daemon itself.
 *
 * `docker stats` is the honest source for a container: `/proc/<pid>` describes the whole container
 * process tree, and the panel's process-tree walker would miss the JVM (its parent is containerd's
 * shim, not the CLI). Reading the daemon's own accounting also means the number matches what the
 * limit is enforced against.
 */
export function containerStats(name: string, timeoutMs = 15_000): ContainerStats {
  const result = dockerCommand(
    ["stats", "--no-stream", "--format", "{{json .}}", name],
    timeoutMs,
  );
  if (!result.ok) return { cpuPercent: null, memoryBytes: null, memoryLimitBytes: null, pids: null };
  const line = result.stdout.split("\n").map((value) => value.trim()).filter(Boolean)[0];
  if (!line) return { cpuPercent: null, memoryBytes: null, memoryLimitBytes: null, pids: null };
  try {
    const parsed = JSON.parse(line) as Record<string, string>;
    return {
      cpuPercent: parsePercent(parsed.CPUPerc ?? ""),
      memoryBytes: parseSize((parsed.MemUsage ?? "").split("/")[0] ?? ""),
      memoryLimitBytes: parseSize((parsed.MemUsage ?? "").split("/")[1] ?? ""),
      pids: Number(parsed.PIDs ?? 0) || null,
    };
  } catch {
    return { cpuPercent: null, memoryBytes: null, memoryLimitBytes: null, pids: null };
  }
}

/** `containerStats` without blocking the event loop. Use this on any request path. */
export async function containerStatsAsync(name: string, timeoutMs = 15_000): Promise<ContainerStats> {
  const result = await dockerCommandAsync(["stats", "--no-stream", "--format", "{{json .}}", name], timeoutMs);
  const empty: ContainerStats = { cpuPercent: null, memoryBytes: null, memoryLimitBytes: null, pids: null };
  if (!result.ok) return empty;
  const line = result.stdout.split("\n").map((value) => value.trim()).filter(Boolean)[0];
  if (!line) return empty;
  try {
    const parsed = JSON.parse(line) as Record<string, string>;
    return {
      cpuPercent: parsePercent(parsed.CPUPerc ?? ""),
      memoryBytes: parseSize((parsed.MemUsage ?? "").split("/")[0] ?? ""),
      memoryLimitBytes: parseSize((parsed.MemUsage ?? "").split("/")[1] ?? ""),
      pids: Number(parsed.PIDs ?? 0) || null,
    };
  } catch {
    return empty;
  }
}

export function parsePercent(text: string): number | null {
  const match = /(-?[\d.]+)\s*%/.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** SIGKILL the container and remove it. The CLI process goes with it, which the manager observes. */
export function killContainer(name: string): { ok: boolean; message: string } {
  const killed = dockerCommand(["kill", name], 20_000);
  const removed = dockerCommand(["rm", "-f", name], 20_000);
  if (removed.ok || killed.ok) {
    /*
     * `--rm` removes the container asynchronously once the process tree is gone, so an immediate
     * `docker inspect` can still find it. Waiting here means the panel's "killed" is true a moment
     * later for everyone else too — the next start reuses the name, and that must not race.
     */
    waitForRemoval(name, 5000);
    return { ok: true, message: "" };
  }
  const message = `${killed.stderr}${removed.stderr}`.trim();
  // "No such container" is success: there is nothing left to kill.
  if (/no such container/i.test(message)) return { ok: true, message: "" };
  return { ok: false, message: firstLine(message) || "docker kill failed" };
}

/** Blocks (briefly) until the container is really gone. Returns true when it is. */
export function waitForRemoval(name: string, timeoutMs = 5000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!inspectContainer(name).exists) return true;
    Bun.sleepSync(120);
  }
  return !inspectContainer(name).exists;
}

export function removeContainer(name: string): { ok: boolean; message: string } {
  const result = dockerCommand(["rm", "-f", name], 20_000);
  if (result.ok) return { ok: true, message: "" };
  const message = `${result.stderr}`.trim();
  if (/no such container/i.test(message)) return { ok: true, message: "" };
  return { ok: false, message: firstLine(message) };
}

/** Containers whose name starts with the panel's prefix — used to spot leftovers at boot. */
export function listPanelContainers(prefix = "rslmc-"): { name: string; running: boolean; status: string }[] {
  const result = dockerCommand(
    ["ps", "-a", "--filter", `name=${prefix}`, "--format", "{{json .}}"],
    20_000,
  );
  if (!result.ok) return [];
  const rows: { name: string; running: boolean; status: string }[] = [];
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, string>;
      rows.push({
        name: String(parsed.Names ?? ""),
        running: String(parsed.State ?? "").toLowerCase() === "running",
        status: String(parsed.Status ?? ""),
      });
    } catch { /* not JSON */ }
  }
  return rows.filter((row) => row.name.startsWith(prefix));
}

export function containerNameFor(uuid: string): string {
  return `rslmc-${uuid}`;
}

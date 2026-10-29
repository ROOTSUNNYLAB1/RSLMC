import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { queryOne, query, run, insert } from "../database";
import { PATHS, serverDir as serverDirFor } from "../shared/config";
import { ApiException } from "../shared/http";
import { bus, serverTopic } from "../events/bus";
import { notify } from "../services/notifications";
import { recordActivity } from "../services/audit";
import { downloadFile, writeFileAtomic } from "../services/download";
import { installServerSoftware, softwareDefinition } from "../minecraft/providers";
import { ensureRuntime, resolveExecutable, runtimeInfo, runtimeIsUsable } from "../java/manager";
import { applyLimits, attachProcess, detectCgroups, killCgroup, readUsage, removeCgroup, resolveMemoryUsage } from "../resources/cgroups";
import { sampleProcess, peekProcess, resetProcessSamples } from "../resources/process-stats";
import { directorySizeSync } from "../resources/host";
import { freemem } from "node:os";
import { scrubSecrets } from "../security/redact";
import { normalizeBindIp, isTcpPortFree, isValidPort } from "../services/net";
import { rediscoverWorlds } from "../minecraft/worlds";
import type { ConsoleLine, ServerMetrics, ServerStatus } from "../shared/types";
import type { RuntimeState } from "./types";
import { findJavaProcessForDirectory, invalidateForeignProcessCache, isProcessAlive } from "./orphans";
import {
  attachRelay, cleanRelayFiles, isRelayAlive, readRelayState, startRelay, type RelayConnection,
} from "./relay-client";
import { playerJoinName, playerLeaveName } from "./console-detect";
import { heapMbFor, initialHeapMbFor } from "../minecraft/jvm-presets";
import { explainCrash } from "./crash-cause";

const CONSOLE_LIMIT = 6000;
// Live usage on the dashboard/overview: one sample per second.
const METRIC_INTERVAL_MS = 1_000;
const METRIC_PERSIST_MS = 15_000;
const DISK_SAMPLE_MS = 60_000;

/**
 * The manager does not care whether a server runs directly under the panel or through the relay:
 * both expose a pid, a stdin-like writer and a kill. Keeping this surface tiny is what allows
 * "Restart RSLMC" to be a non-event for running servers.
 */
export interface ProcessHandle {
  pid: number | null;
  stdin: { write(chunk: string): number | void; flush(): void } | null;
  kill(signal?: string | number): void;
}

interface ManagedProcess {
  state: RuntimeState;
  process: ProcessHandle | null;
  /** Present when the server is owned by a relay (normal case since 2026.10.29). */
  relay?: RelayConnection | null;
  stdoutReader?: ReadableStreamDefaultReader<Uint8Array>;
  stderrReader?: ReadableStreamDefaultReader<Uint8Array>;
  metricTimer?: ReturnType<typeof setInterval>;
  stopTimer?: ReturnType<typeof setTimeout>;
  diskBytes: number;
  lastDiskSample: number;
  lastPersist: number;
  stoppingRequested: boolean;
  restarting: boolean;
  pendingLines: ConsoleLine[];
  flushTimer?: ReturnType<typeof setTimeout>;
  lastCpu: number;
}

const managed = new Map<number, ManagedProcess>();

/* ------------------------------------------------------------------ */
/* Persistence helpers                                                 */
/* ------------------------------------------------------------------ */

interface ServerRow {
  id: number;
  uuid: string;
  name: string;
  software: string;
  software_version: string;
  mc_version: string;
  status: string;
  memory_mb: number;
  cpu_percent: number;
  disk_mb: number;
  bind_ip: string;
  port: number;
  java_runtime_id: number | null;
  java_major: number;
  startup_command: string;
  jvm_args: string;
  server_args: string;
  crash_recovery: number;
  auto_start: number;
  rcon_password: string | null;
  node_id: number;
  install_log: string | null;
  eula_accepted?: number;
}

export function getServerRow(serverId: number): ServerRow {
  const row = queryOne<ServerRow>("SELECT * FROM servers WHERE id = ?", [serverId]);
  if (!row) throw new ApiException(404, "server_not_found", "Server not found");
  return row;
}

export function setStatus(serverId: number, status: ServerStatus): void {
  run("UPDATE servers SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", [status, serverId]);
  const state = managed.get(serverId);
  if (state) state.state.status = status;
  bus.publish(serverTopic(serverId), {
    type: "status",
    serverId,
    status,
    uptimeSeconds: uptimeSeconds(serverId),
  });
}

export function uptimeSeconds(serverId: number): number {
  const entry = managed.get(serverId);
  if (!entry?.state.startedAt) return 0;
  return Math.floor((Date.now() - entry.state.startedAt) / 1000);
}

/* ------------------------------------------------------------------ */
/* Console plumbing                                                    */
/* ------------------------------------------------------------------ */

function ensureEntry(serverId: number): ManagedProcess {
  let entry = managed.get(serverId);
  if (!entry) {
    entry = {
      state: {
        serverId, status: "offline", pid: null, startedAt: null, stoppingAt: null, exitCode: null,
        lastError: null, console: [], players: new Map(), ready: false, stopKind: null,
        cgroupAttached: false, enforcementMessage: null, foreign: false,
      },
      process: null, diskBytes: 0, lastDiskSample: 0, lastPersist: 0,
      stoppingRequested: false, restarting: false, pendingLines: [], lastCpu: 0,
    };
    managed.set(serverId, entry);
  }
  return entry;
}

export function consoleHistory(serverId: number): ConsoleLine[] {
  return ensureEntry(serverId).state.console.slice();
}

/**
 * The rcon password is only used to redact it from output. Reading it from SQLite for every
 * single console line made a chatty server (Paper emits dozens of lines per second) do a
 * query per line — that is what made the console feel late. Cache it instead.
 */
const rconCache = new Map<number, string | null>();

export function invalidateServerCaches(serverId?: number): void {
  if (serverId === undefined) rconCache.clear();
  else rconCache.delete(serverId);
}

function rconPasswordFor(serverId: number): string | null {
  if (rconCache.has(serverId)) return rconCache.get(serverId) ?? null;
  const row = queryOne<{ rcon_password: string | null }>("SELECT rcon_password FROM servers WHERE id = ?", [serverId]);
  const value = row?.rcon_password ?? null;
  rconCache.set(serverId, value);
  return value;
}

const FLUSH_INTERVAL_MS = 40;

function pushLine(serverId: number, line: ConsoleLine): void {
  const entry = ensureEntry(serverId);
  const safeText = scrubSecrets(line.text, [rconPasswordFor(serverId)]);
  const safeLine: ConsoleLine = { ts: line.ts, stream: line.stream, text: safeText };
  entry.state.console.push(safeLine);
  if (entry.state.console.length > CONSOLE_LIMIT) {
    entry.state.console.splice(0, entry.state.console.length - CONSOLE_LIMIT);
  }
  entry.pendingLines.push(safeLine);
  if (!entry.flushTimer) {
    entry.flushTimer = setTimeout(() => {
      const entryNow = managed.get(serverId);
      if (!entryNow) return;
      const batch = entryNow.pendingLines.splice(0, entryNow.pendingLines.length);
      entryNow.flushTimer = undefined;
      if (batch.length > 0) {
        // Real line timestamps + per-line streams: batching must not rewrite either.
        bus.publish(serverTopic(serverId), { type: "console", serverId, lines: batch });
      }
    }, FLUSH_INTERVAL_MS);
  }
  handleConsoleTriggers(serverId, safeText);
}

/** Appends a panel-generated line to a server's console buffer (visible to every client). */
export function systemLine(serverId: number, text: string): void {
  pushLine(serverId, { ts: Date.now(), stream: "system", text });
}

/* ------------------------------------------------------------------ */
/* Console parsing: readiness, players, crashes                        */
/* ------------------------------------------------------------------ */

const READY_PATTERNS = [
  /Done \([0-9.,]+s\)!/,
  /Done \([0-9.,]+s\)! For help, type "help"/,
  /Listening on \/[0-9.]+:[0-9]+/,
];

function handleConsoleTriggers(serverId: number, text: string): void {
  const entry = ensureEntry(serverId);
  if (!entry.state.ready && READY_PATTERNS.some((pattern) => pattern.test(text))) {
    entry.state.ready = true;
    setStatus(serverId, "online");
    run("UPDATE servers SET last_started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", [serverId]);
    recordActivity({
      type: "server.started", serverId, target: getServerRow(serverId).name,
      metadata: { pid: entry.state.pid },
    });
  }
  const joined = playerJoinName(text);
  if (joined) markPlayerOnline(serverId, joined);
  const left = playerLeaveName(text);
  if (left) markPlayerOffline(serverId, left);
}

function uuidForPlayer(serverId: number, username: string): string {
  const existing = queryOne<{ uuid: string }>("SELECT uuid FROM players WHERE server_id = ? AND lower(username) = lower(?)", [serverId, username]);
  if (existing) return existing.uuid;
  // Offline-mode fallback; online-mode UUIDs are reconciled from usercache.json when available.
  const offline = queryOne<{ uuid: string }>("SELECT uuid FROM players WHERE server_id = ? AND lower(username) = lower(?)", [serverId, username]);
  return offline?.uuid ?? `offline:${username.toLowerCase()}`;
}

/**
 * Reconciles a name captured from the console against the server's own `usercache.json`.
 * Minecraft writes the authoritative name/UUID there on login, so a mangled capture
 * ("85mSUNNYGAMINGPE") is healed instead of being stored as a new player.
 */
function canonicalIdentity(serverId: number, captured: string): { name: string; uuid: string | null } {
  const server = queryOne<{ uuid: string }>("SELECT uuid FROM servers WHERE id = ?", [serverId]);
  if (!server) return { name: captured, uuid: null };
  try {
    const entries = JSON.parse(readFileSync(join(serverDirFor(server.uuid), "usercache.json"), "utf8")) as
      { name?: string; uuid?: string }[];
    if (!Array.isArray(entries)) return { name: captured, uuid: null };
    const needle = captured.toLowerCase();
    const exact = entries.find((entry) => entry.name?.toLowerCase() === needle);
    if (exact?.name) return { name: exact.name, uuid: exact.uuid ?? null };
    const suffix = entries.find((entry) => entry.name && needle.endsWith(entry.name.toLowerCase()));
    if (suffix?.name) return { name: suffix.name, uuid: suffix.uuid ?? null };
    const prefix = entries.find((entry) => entry.name && needle.startsWith(entry.name.toLowerCase()));
    if (prefix?.name) return { name: prefix.name, uuid: prefix.uuid ?? null };
  } catch { /* no usercache yet — first join of a brand-new server */ }
  return { name: captured, uuid: null };
}

export function markPlayerOnline(serverId: number, capturedName: string): void {
  const identity = canonicalIdentity(serverId, capturedName);
  const username = identity.name;
  const uuid = identity.uuid ?? uuidForPlayer(serverId, username);

  // A previously mis-detected record (e.g. "85mSUNNYGAMINGPE") is folded into the real player
  // instead of lingering in the list forever.
  if (username.toLowerCase() !== capturedName.toLowerCase()) {
    const stale = queryOne<{ id: number; uuid: string }>(
      "SELECT id, uuid FROM players WHERE server_id = ? AND lower(username) = lower(?)", [serverId, capturedName],
    );
    if (stale && stale.uuid !== uuid) {
      run("DELETE FROM player_sessions WHERE server_id = ? AND player_uuid = ?", [serverId, stale.uuid]);
      run("DELETE FROM players WHERE id = ?", [stale.id]);
      systemLine(serverId, `Merged a mis-detected player record "${capturedName}" into "${username}".`);
    }
  }
  const now = new Date().toISOString();
  const existing = queryOne<{ id: number; online: number; session_start_at: string | null }>(
    "SELECT id, online, session_start_at FROM players WHERE server_id = ? AND uuid = ?", [serverId, uuid],
  );
  if (existing) {
    run(
      `UPDATE players SET online = 1, session_start_at = ?, last_join_at = ?, last_seen_at = ?,
       first_seen_at = COALESCE(first_seen_at, ?) WHERE id = ?`,
      [now, now, now, now, existing.id],
    );
  } else {
    insert(
      "INSERT INTO players (server_id, uuid, username, online, session_start_at, last_join_at, last_seen_at) VALUES (?, ?, ?, 1, ?, ?, ?)",
      [serverId, uuid, username, now, now, now],
    );
  }
  insert("INSERT INTO player_sessions (server_id, player_uuid, username, joined_at) VALUES (?, ?, ?, ?)", [serverId, uuid, username, now]);
  const entry = ensureEntry(serverId);
  entry.state.players.set(uuid, { name: username, uuid, joinedAt: Date.now() });
  publishPlayers(serverId);
  recordActivity({ type: "player.joined", serverId, target: username, metadata: { uuid } });
}

export function markPlayerOffline(serverId: number, capturedName: string): void {
  const identity = canonicalIdentity(serverId, capturedName);
  const username = identity.name;
  const uuid = identity.uuid ?? uuidForPlayer(serverId, username);
  const now = new Date().toISOString();
  const row = queryOne<{ id: number; session_start_at: string | null; playtime_seconds: number }>(
    "SELECT id, session_start_at, playtime_seconds FROM players WHERE server_id = ? AND uuid = ?", [serverId, uuid],
  );
  if (row) {
    const start = row.session_start_at ? new Date(row.session_start_at).getTime() : Date.now();
    const elapsed = Math.max(0, Math.floor((Date.now() - start) / 1000));
    run("UPDATE players SET online = 0, session_start_at = NULL, last_seen_at = ?, playtime_seconds = ? WHERE id = ?", [
      now, row.playtime_seconds + elapsed, row.id,
    ]);
    const session = queryOne<{ id: number }>(
      "SELECT id FROM player_sessions WHERE server_id = ? AND player_uuid = ? AND left_at IS NULL ORDER BY id DESC LIMIT 1",
      [serverId, uuid],
    );
    if (session) run("UPDATE player_sessions SET left_at = ?, duration_seconds = ? WHERE id = ?", [now, elapsed, session.id]);
  }
  ensureEntry(serverId).state.players.delete(uuid);
  publishPlayers(serverId);
  recordActivity({ type: "player.left", serverId, target: username, metadata: { uuid } });
}

export function publishPlayers(serverId: number): void {
  const entry = ensureEntry(serverId);
  bus.publish(serverTopic(serverId), {
    type: "players",
    serverId,
    players: [...entry.state.players.values()].map((player) => ({
      name: player.name,
      uuid: player.uuid,
      joinedAt: player.joinedAt,
      sessionSeconds: Math.floor((Date.now() - player.joinedAt) / 1000),
      operator: Boolean(queryOne("SELECT 1 AS ok FROM operators WHERE server_id = ? AND name = ?", [serverId, player.name])),
      whitelisted: Boolean(queryOne("SELECT 1 AS ok FROM whitelist WHERE server_id = ? AND name = ?", [serverId, player.name])),
    })),
  });
}

/* ------------------------------------------------------------------ */
/* Launch command construction                                         */
/* ------------------------------------------------------------------ */

export interface LaunchPlan {
  command: string[];
  cwd: string;
  shellScript: string | null;
  preview: string;
}

/**
 * The jar (or Forge/NeoForge launcher script) this server is supposed to run. Returns null when the
 * directory has no server software — a start must then fail loudly instead of launching
 * `java -Xms… -Xmx… nogui`, which used to surface as "Could not find or load main class nogui".
 */
export function findLaunchTarget(server: ServerRow): { jar: string | null; script: string | null } {
  const directory = serverDirFor(server.uuid);
  if (!existsSync(directory)) return { jar: null, script: null };
  const entries = readdirSync(directory);
  if (server.software === "forge" || server.software === "neoforge") {
    const scriptName = process.platform === "win32" ? "run.bat" : "run.sh";
    if (entries.includes(scriptName)) return { jar: null, script: scriptName };
  }
  const jar = entries.find((entry) => entry === "server.jar")
    ?? entries.find((entry) => /^fabric-server.*\.jar$/.test(entry))
    ?? entries.find((entry) => /^quilt-server.*\.jar$/.test(entry))
    ?? entries.find((entry) => /\.jar$/.test(entry) && !/installer/i.test(entry))
    ?? null;
  return { jar, script: null };
}

export function buildLaunchPlan(server: ServerRow): LaunchPlan {
  const javaRuntime = server.java_runtime_id ? runtimeInfo(server.java_runtime_id) : null;
  const javaExe = resolveExecutable(javaRuntime) ?? "java";
  const directory = serverDirFor(server.uuid);

  const memoryMb = heapMbFor(server.memory_mb);
  const initialMemoryMb = initialHeapMbFor(server.memory_mb);
  const jvmArgs = server.jvm_args?.trim() ? server.jvm_args.trim().split(/\s+/) : [];
  const serverArgs = server.server_args?.trim() ? server.server_args.trim().split(/\s+/) : [];

  let jar: string | null = null;
  const software = server.software;
  if (existsSync(directory)) {
    const entries = readdirSync(directory);
    if (software === "forge" || software === "neoforge") {
      const script = entries.find((entry) => entry === (process.platform === "win32" ? "run.bat" : "run.sh"));
      if (script) {
        return {
          command: process.platform === "win32" ? ["cmd.exe", "/c", script] : ["sh", script],
          cwd: directory,
          shellScript: script,
          preview: `${script} (Forge/NeoForge generated launcher, memory from user_jvm_args.txt)`,
        };
      }
    }
    const preferred = entries.find((entry) => entry === "server.jar")
      ?? entries.find((entry) => /^fabric-server.*\.jar$/.test(entry))
      ?? entries.find((entry) => /^quilt-server.*\.jar$/.test(entry))
      ?? entries.find((entry) => /\.jar$/.test(entry) && !/installer/i.test(entry));
    jar = preferred ?? null;
  }

  const command = [
    javaExe,
    `-Xms${initialMemoryMb}M`,
    `-Xmx${memoryMb}M`,
    ...jvmArgs,
    // Absolute path: on Windows the command line is the only way to map a JVM back to a server.
    ...(jar ? ["-jar", join(directory, jar)] : []),
    ...serverArgs,
  ];
  return {
    command,
    cwd: directory,
    shellScript: null,
    preview: command.join(" "),
  };
}

function prepareJvmArgsFile(server: ServerRow, directory: string): void {
  const file = join(directory, "user_jvm_args.txt");
  if (!existsSync(file)) return;
  const heap = heapMbFor(server.memory_mb);
  const memory = `-Xms${initialHeapMbFor(server.memory_mb)}M -Xmx${heap}M`;
  const extras = server.jvm_args?.trim() ?? "";
  writeFileSync(file, `# Written by RSLMC — memory limits follow the server allocation\n${memory}\n${extras}\n`);
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

const transitions = new Map<number, Promise<unknown>>();

/** How long the panel waits before warning that a server never reported readiness. */
const STARTUP_TIMEOUT_MS = Math.max(60, Number(process.env.RSLMC_STARTUP_TIMEOUT_SEC ?? 300)) * 1000;

/** Serialises lifecycle operations per server so conflicting actions cannot interleave. */
function withLock<T>(serverId: number, fn: () => Promise<T>): Promise<T> {
  const previous = transitions.get(serverId) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  transitions.set(serverId, next.catch(() => undefined));
  return next;
}

export async function startServer(serverId: number, actor = "system"): Promise<void> {
  return withLock(serverId, async () => {
    const entry = ensureEntry(serverId);
    const server = getServerRow(serverId);
    if (["starting", "online", "stopping", "restarting"].includes(entry.state.status)) {
      throw new ApiException(409, "invalid_state", `Server is already ${entry.state.status}`);
    }
    if (entry.state.foreign && entry.state.pid && isProcessAlive(entry.state.pid)) {
      throw new ApiException(
        409, "foreign_process",
        `A Java process that RSLMC did not start (pid ${entry.state.pid}) is already running this server's directory. Force-kill it before starting the server from the panel, otherwise two servers would bind the same port.`,
      );
    }
    const directory = serverDirFor(server.uuid);
    if (!existsSync(directory)) throw new ApiException(400, "not_installed", "Server directory is missing — install the server first");

    // The EULA is accepted once, at creation (or through the EULA prompt). If the file went
    // missing — failed install, restored backup, wiped directory — restore it instead of
    // dead-ending the Start action with a confusing power error.
    const eula = join(directory, "eula.txt");
    const eulaOk = existsSync(eula) && /eula\s*=\s*true/i.test(await Bun.file(eula).text());
    if (!eulaOk) {
      if (server.eula_accepted === 1) {
        writeFileAtomic(eula, "# Restored by RSLMC: the EULA was accepted for this server.\neula=true\n");
        systemLine(serverId, "eula.txt was missing — restored from the acceptance recorded when this server was created.");
      } else {
        throw new ApiException(400, "eula_required", "The Minecraft EULA has not been accepted for this server");
      }
    }

    const bindIp = normalizeBindIp(server.bind_ip);
    if (!isValidPort(server.port)) throw new ApiException(400, "invalid_port", "Server port is invalid");
    const free = await isTcpPortFree(bindIp, server.port);
    if (!free) throw new ApiException(409, "port_in_use", `Port ${server.port} is already in use on ${bindIp}`);

    // Java runtime: resolve or install the exact major version this server requires.
    let runtimeId = server.java_runtime_id;
    const runtime = runtimeId ? runtimeInfo(runtimeId) : null;
    // resolveExecutable() only proves the file exists — a runtime left truncated by an interrupted
    // extraction still fails at exec time with "libjli.so: cannot open shared object file".
    if (!runtime || !runtimeIsUsable(runtime)) {
      systemLine(serverId, `Java ${server.java_major} runtime is missing — installing Eclipse Temurin ${server.java_major}…`);
      const installed = await ensureRuntime(server.java_major, server.node_id);
      runtimeId = installed.id;
      run("UPDATE servers SET java_runtime_id = ? WHERE id = ?", [runtimeId, serverId]);
      server.java_runtime_id = runtimeId;
    }

    const target = findLaunchTarget(server);
    if (!target.jar && !target.script) {
      throw new ApiException(
        409, "not_installed",
        "This server's directory has no server jar, so there is nothing to launch. Run "
        + "\"Retry installation\" (or reinstall) to download the software again, then start it.",
      );
    }

    setStatus(serverId, "starting");
    entry.state.foreign = false; // this process is ours: output and stdin are both piped
    entry.state.startedAt = Date.now();
    entry.state.exitCode = null;
    entry.state.ready = false;
    entry.stoppingRequested = false;
    entry.state.stopKind = null;
    entry.state.lastError = null;
    entry.state.players.clear();
    entry.diskBytes = directorySizeSync(directory);
    entry.lastDiskSample = Date.now();

    const plan = buildLaunchPlan(server);
    prepareJvmArgsFile(server, directory);
    systemLine(serverId, `Starting ${softwareDefinition(server.software as any).name} ${server.mc_version} on ${server.bind_ip}:${server.port}`);
    systemLine(serverId, `Launch: ${plan.preview}`);

    /*
     * Host memory sanity check. The allocation is the server's budget and the panel never silently
     * shrinks it, but a budget larger than what the machine actually has free is the usual reason a
     * start ends in an OOM kill. Say so up front instead of leaving "exited unexpectedly" in the log.
     */
    const hostFreeMb = Math.round(freemem() / 1024 ** 2);
    const committedMb = Math.round(
      query<{ total: number }>(
        "SELECT COALESCE(SUM(memory_mb), 0) AS total FROM servers WHERE status IN ('starting','online','stopping')",
      )[0]?.total ?? 0,
    );
    if (server.memory_mb > hostFreeMb - 256) {
      systemLine(serverId,
        `Memory warning: ${server.memory_mb} MB requested, only ${hostFreeMb} MB free on the host`
        + `${committedMb > server.memory_mb ? ` (${committedMb} MB already allocated to running servers)` : ""}.`
        + " The kernel may kill the JVM (SIGKILL) if the box runs out.",
      );
    }

    // Apply kernel-level limits before handing over the process.
    const capabilities = detectCgroups();
    let enforcementMessage: string | null = null;
    if (capabilities.privileged) {
      const limits = applyLimits({
        serverId,
        memoryBytes: server.memory_mb * 1024 * 1024,
        cpuPercent: server.cpu_percent,
      });
      enforcementMessage = limits.ok ? "Kernel limits applied (cgroup v2)" : `Kernel limits unavailable: ${limits.message}`;
      if (!limits.ok) systemLine(serverId, enforcementMessage);
    } else {
      enforcementMessage = capabilities.reason;
    }
    entry.state.enforcementMessage = enforcementMessage;

    const spawnEnv: Record<string, string> = {
      RSLMC_SERVER_ID: String(serverId),
      ...(server.rcon_password ? { RSLMC_RCON_PASSWORD: server.rcon_password } : {}),
    };

    /*
     * Start through the relay when possible. The relay is a detached process that owns the JVM, so
     * the server keeps running — with a working console — while the panel restarts itself for an
     * update. If the relay cannot be brought up, fall back to the classic in-process spawn rather
     * than refusing to start the server.
     */
    let proc: ProcessHandle | null = null;
    entry.relay = null;
    if (process.env.RSLMC_SERVER_RELAY !== "0") {
      const relay = await startRelay({
        serverId,
        uuid: server.uuid,
        command: plan.command as string[],
        cwd: plan.cwd,
        env: spawnEnv,
        onLine: (line) => pushLine(serverId, {
          ts: line.ts,
          stream: line.stream === "system" ? "stdout" : line.stream,
          text: line.text,
        }),
        onExit: (code, signal) => handleExit(serverId, code, signal),
        onNotice: (message) => systemLine(serverId, `Relay: ${message}`),
      });
      if (relay) {
        entry.relay = relay;
        proc = relay;
        entry.state.relayed = true;
        systemLine(serverId, "Started through the RSLMC relay — this server keeps running if the panel restarts.");
      } else {
        systemLine(serverId, "The server relay could not be started; falling back to a direct process. A panel restart will leave this server running but without a console.");
      }
    }

    if (!proc) {
      try {
        const direct = Bun.spawn(plan.command, {
          cwd: plan.cwd,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, ...spawnEnv },
          onExit(_proc, exitCode, signalCode) {
            handleExit(serverId, exitCode, signalCode);
          },
        });
        proc = direct as unknown as ProcessHandle;
      } catch (err) {
        setStatus(serverId, "error");
        const message = err instanceof Error ? err.message : String(err);
        entry.state.lastError = message;
        systemLine(serverId, `Failed to spawn process: ${message}`);
        throw new ApiException(500, "spawn_failed", `Could not start the server process: ${message}`);
      }
    }

    entry.process = proc;
    entry.state.pid = proc.pid ?? null;

    if (proc.pid && capabilities.privileged) {
      const attach = attachProcess(serverId, proc.pid);
      entry.state.cgroupAttached = attach.ok;
      if (!attach.ok) systemLine(serverId, `Could not attach process to cgroup: ${attach.message}`);
    }

    const direct = proc as unknown as ReturnType<typeof Bun.spawn>;
    if (!entry.relay) {
      readStream(serverId, direct.stdout as ReadableStream<Uint8Array> | undefined, "stdout", entry);
      readStream(serverId, direct.stderr as ReadableStream<Uint8Array> | undefined, "stderr", entry);
    }
    startMetrics(serverId, entry);

    /*
     * Startup watchdog. This only *warns* — a slow host (first Paper boot remaps the server jar,
     * which alone can take a minute on shared CPU) must not be killed for being slow. Operators
     * can raise the window with RSLMC_STARTUP_TIMEOUT_SEC.
     */
    setTimeout(() => {
      const current = managed.get(serverId);
      if (current && current.state.status === "starting" && !current.state.ready) {
        const seconds = Math.round(STARTUP_TIMEOUT_MS / 1000);
        systemLine(serverId, `Startup warning: no readiness message after ${seconds} seconds — still starting (not killed). Check the console if this persists.`);
        notify({
          title: `${server.name} is taking longer than usual to start`,
          body: `No readiness message after ${seconds} seconds. The process is still running; check the console for errors.`,
          severity: "warning", kind: "server_startup", link: `/servers/${serverId}/console`,
        });
      }
    }, STARTUP_TIMEOUT_MS);

    recordActivity({
      type: "server.start", serverId, target: server.name, actorName: actor,
      metadata: { java: server.java_major, memoryMb: server.memory_mb, cpuPercent: server.cpu_percent },
    });
  });
}

function readStream(
  serverId: number,
  stream: ReadableStream<Uint8Array> | undefined,
  kind: "stdout" | "stderr",
  entry: ManagedProcess,
): void {
  if (!stream) return;
  (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let partial = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        partial += decoder.decode(value, { stream: true });
        const lines = partial.split(/\r?\n/);
        partial = lines.pop() ?? "";
        for (const line of lines) {
          if (line.length > 0) pushLine(serverId, { ts: Date.now(), stream: kind, text: line });
        }
      }
      if (partial.trim().length > 0) pushLine(serverId, { ts: Date.now(), stream: kind, text: partial });
    } catch (err) {
      if (managed.has(serverId)) {
        systemLine(serverId, `Console stream closed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
  })();
}

function handleExit(serverId: number, exitCode: number | null, signalCode: string | number | null): void {
  const entry = managed.get(serverId);
  if (!entry) return;
  const server = queryOne<ServerRow>("SELECT * FROM servers WHERE id = ?", [serverId]);
  const wasStopping = entry.stoppingRequested;
  const wasRestarting = entry.restarting;
  entry.state.exitCode = exitCode;
  entry.process = null;
  entry.state.pid = null;
  entry.state.ready = false;
  entry.state.startedAt = null;
  entry.lastCpu = 0; // CPU history for a dead process must not stay at the last live value.
  entry.state.foreign = false;
  stopMetrics(serverId);

  // Everyone still shown as online leaves when the process dies.
  for (const player of [...entry.state.players.values()]) markPlayerOffline(serverId, player.name);

  removeCgroup(serverId);
  entry.state.cgroupAttached = false;
  entry.state.relayed = false;
  entry.relay = null;
  // The relay removes its own state file, but a killed relay cannot: clear ours either way.
  setTimeout(() => cleanRelayFiles(serverId), 1200);

  if (wasRestarting) {
    systemLine(serverId, "Server stopped for restart.");
    setStatus(serverId, "restarting");
    return;
  }

  if (wasStopping || shuttingDown) {
    const graceful = exitCode === 0 || exitCode === 143 || signalCode === "SIGTERM";
    entry.state.stopKind = graceful ? "graceful" : "forced";
    setStatus(serverId, "offline");
    systemLine(serverId, graceful
      ? `Server stopped gracefully (exit code ${exitCode ?? 0}).`
      : `Server process terminated (exit code ${exitCode ?? "signal"}).`);
    recordActivity({
      type: graceful ? "server.stopped" : "server.killed",
      serverId, target: server?.name ?? `#${serverId}`,
      metadata: { exitCode, signal: signalCode, mode: graceful ? "graceful" : "forced" },
    });
    entry.stoppingRequested = false;
    return;
  }

  // Unexpected exit → crashed. Name the cause when the console makes it obvious, instead of leaving
  // a bare exit code that sends the operator looking in the wrong place.
  setStatus(serverId, "crashed");
  const cause = explainCrash({
    lines: entry.state.console.slice(-250),
    exitCode: exitCode ?? null,
    signalCode: signalCode == null ? null : String(signalCode),
    memoryMb: server?.memory_mb,
  });
  entry.state.lastError = cause.message;
  systemLine(serverId, `Server process exited unexpectedly (code ${exitCode ?? "signal " + signalCode}).`);
  systemLine(serverId, cause.message);
  if (server && cause.kind === "out_of_memory") {
    systemLine(
      serverId,
      `Current allocation: ${server.memory_mb} MB (heap ${heapMbFor(server.memory_mb)} MB). ` +
        "Edit the server's memory on the Settings page; a vanilla 1.21 server needs at least 1024 MB to start.",
    );
  }
  recordActivity({
    type: "server.crashed", serverId, target: server?.name ?? `#${serverId}`, result: "failure",
    metadata: { exitCode, signal: signalCode, cause: cause.kind },
  });
  if (server) {
    notify({
      title: `${server.name} crashed`,
      body: cause.message,
      severity: "error", kind: "server_crash", link: `/servers/${serverId}/console`,
      dedupeKey: `crash:${serverId}`,
    });
    if (server.crash_recovery === 1) {
      setStatus(serverId, "recovering");
      systemLine(serverId, "Crash recovery is enabled — restarting in 10 seconds.");
      setTimeout(() => {
        startServer(serverId, "crash-recovery").catch((err) => {
          systemLine(serverId, `Crash recovery restart failed: ${err instanceof Error ? err.message : String(err)}`);
          setStatus(serverId, "error");
        });
      }, 10_000);
    }
  }
}

export async function stopServer(serverId: number, actor = "system", opts: { timeoutMs?: number } = {}): Promise<void> {
  return withLock(serverId, async () => {
    const entry = ensureEntry(serverId);
    const server = getServerRow(serverId);
    if (!entry.process || !entry.state.pid) throw new ApiException(409, "invalid_state", "Server is not running");
    if (entry.state.foreign) {
      // No stdin pipe exists for a process we did not spawn, so a graceful stop is impossible.
      throw new ApiException(
        409, "foreign_process",
        `RSLMC did not start this server's process (pid ${entry.state.pid}), so it cannot send it a stop command. Use Force kill, then start the server from the panel.`,
      );
    }
    if (entry.state.status === "stopping") return;

    const timeoutMs = opts.timeoutMs ?? 45_000;
    entry.stoppingRequested = true;
    entry.state.stoppingAt = Date.now();
    setStatus(serverId, "stopping");
    systemLine(serverId, "Sending graceful stop command to the server console…");
    sendCommandRaw(serverId, "stop");

    entry.stopTimer = setTimeout(() => {
      const current = managed.get(serverId);
      if (current?.state.status === "stopping") {
        systemLine(serverId, `Server did not stop within ${Math.round(timeoutMs / 1000)}s — terminating the process tree.`);
        notify({
          title: `${server.name} did not stop gracefully`,
          body: "RSLMC terminated the process after the shutdown timeout expired.",
          severity: "warning", kind: "server_stop", link: `/servers/${serverId}/console`,
        });
        void forceKill(serverId, "shutdown-timeout");
      }
    }, timeoutMs);
    recordActivity({ type: "server.stop", serverId, target: server.name, actorName: actor });
  });
}

export async function killServer(serverId: number, actor = "system"): Promise<void> {
  return withLock(serverId, async () => {
    const entry = ensureEntry(serverId);
    if (!entry.process && !entry.state.pid) throw new ApiException(409, "invalid_state", "Server is not running");
    entry.stoppingRequested = true;
    systemLine(serverId, "Force-kill requested by administrator.");
    recordActivity({ type: "server.kill", serverId, target: getServerRow(serverId).name, actorName: actor, result: "info" });
    await forceKill(serverId, actor);
  });
}

async function forceKill(serverId: number, actor: string): Promise<void> {
  const entry = managed.get(serverId);
  if (!entry) return;
  if (entry.stopTimer) { clearTimeout(entry.stopTimer); entry.stopTimer = undefined; }

  // cgroup.kill is a supplement, never a substitute: an adopted JVM was never placed in the
  // server's cgroup, so issuing cgroup.kill "succeeded" while the process kept running. Kill the
  // tracked pid tree as well, then verify.
  if (killCgroup(serverId)) {
    systemLine(serverId, "cgroup.kill issued for the server's cgroup.");
  }
  const rootPid = entry.state.pid;
  if (rootPid) {
    try {
      if (process.platform === "win32") {
        Bun.spawnSync(["taskkill", "/PID", String(rootPid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
      } else {
        // Kill the whole tree: children first, then the parent.
        const pids = collectTree(rootPid).filter((pidValue) => pidValue > 1);
        for (const childPid of [...pids].reverse()) {
          try { process.kill(childPid, "SIGTERM"); } catch { /* ignore */ }
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
        for (const childPid of [...pids].reverse()) {
          try { process.kill(childPid, "SIGKILL"); } catch { /* ignore */ }
        }
        if (rootPid > 1) { try { process.kill(rootPid, "SIGKILL"); } catch { /* ignore */ } }
      }
    } catch (err) {
      systemLine(serverId, `Kill failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Never report a kill that did not happen.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && isProcessAlive(rootPid)) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (isProcessAlive(rootPid)) {
      systemLine(
        serverId,
        `The process (pid ${rootPid}) is still alive after SIGKILL — it may belong to another user or be stuck in uninterruptible I/O. `
        + "Check the node's process list; the panel will keep reporting it as running.",
      );
      recordActivity({
        type: "server.kill_failed", serverId, target: getServerRow(serverId).name, actorName: actor,
        result: "failure", metadata: { pid: rootPid },
      });
      return;
    }
    systemLine(serverId, `Process ${rootPid} terminated.`);
  }

  entry.stoppingRequested = true;
  entry.state.stopKind = "forced";
  setTimeout(() => {
    const current = managed.get(serverId);
    if (current && current.state.status !== "offline") {
      current.process = null;
      current.state.pid = null;
      current.state.startedAt = null;
      // Killing an adopted JVM produces no exit event, so the "not ours" flag has to be cleared here.
      current.state.foreign = false;
      setStatus(serverId, "offline");
    }
  }, 1500);
  recordActivity({ type: "server.killed", serverId, target: `server #${serverId}`, actorName: actor, result: "info" });
}

function collectTree(pid: number): number[] {
  const out: number[] = [pid];
  try {
    const result = Bun.spawnSync(["sh", "-c", `ps -o pid= --ppid ${Number(pid)} 2>/dev/null`], { stdout: "pipe", stderr: "ignore" });
    // Blank lines from `ps` become Number("") === 0, and `process.kill(0, …)` targets the whole
    // process group — i.e. the panel itself. Only accept real pids (> 1).
    const children = result.stdout.toString().split("\n")
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line))
      .map(Number)
      .filter((pidValue) => Number.isInteger(pidValue) && pidValue > 1);
    for (const child of children) out.push(...collectTree(child));
  } catch { /* ignore */ }
  return out;
}

export async function restartServer(serverId: number, actor = "system", opts: { force?: boolean } = {}): Promise<void> {
  const entry = ensureEntry(serverId);
  const server = getServerRow(serverId);
  if (!entry.process) {
    await startServer(serverId, actor);
    return;
  }
  entry.restarting = true;
  setStatus(serverId, "stopping");
  recordActivity({ type: "server.restart", serverId, target: server.name, actorName: actor });
  systemLine(serverId, "Restart requested — stopping the server first.");

  await new Promise<void>((resolve) => {
    const startedAt = Date.now();
    entry.stoppingRequested = true;
    entry.restarting = true;
    sendCommandRaw(serverId, "stop");
    const poll = setInterval(() => {
      const current = managed.get(serverId);
      if (!current?.process) {
        clearInterval(poll);
        resolve();
        return;
      }
      if (Date.now() - startedAt > 45_000) {
        clearInterval(poll);
        void forceKill(serverId, "restart-timeout");
        setTimeout(resolve, 2000);
      }
    }, 500);
  });

  entry.restarting = false;
  entry.stoppingRequested = false;
  setStatus(serverId, "offline");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await startServer(serverId, actor);
}

/* ------------------------------------------------------------------ */
/* Console input                                                       */
/* ------------------------------------------------------------------ */

function sendCommandRaw(serverId: number, command: string): void {
  const entry = managed.get(serverId);
  if (!entry?.process?.stdin) throw new ApiException(409, "not_running", "Server console is not available");
  const sink = entry.process.stdin;
  sink.write(`${command}\n`);
  sink.flush();
}

export function sendCommand(serverId: number, command: string, actor = "system"): void {
  const entry = ensureEntry(serverId);
  if (!entry.process) throw new ApiException(409, "not_running", "Server is not running");
  const trimmed = command.replace(/[\r\n]/g, " ").slice(0, 1000).trim();
  if (!trimmed) throw new ApiException(400, "empty_command", "Command is empty");
  sendCommandRaw(serverId, trimmed);
  pushLine(serverId, { ts: Date.now(), stream: "input", text: `> ${trimmed}` });
  recordActivity({
    type: "console.command", serverId, target: trimmed.slice(0, 120), actorName: actor,
    metadata: { command: trimmed.slice(0, 400) },
  });
}

/* ------------------------------------------------------------------ */
/* Metrics                                                             */
/* ------------------------------------------------------------------ */

/**
 * When the host hands out a cgroup that does not charge the server's pages, the panel reports the
 * process RSS instead — and says so once per start, in the console and in the server's enforcement
 * note, so nobody reads "kernel limits applied" and expects a number that came from the kernel.
 */
const cgroupAccountingWarned = new Set<number>();

function noteCgroupAccounting(
  serverId: number,
  memory: { source: "cgroup" | "/proc" | "none"; cgroupTrusted: boolean },
  cgroupBytes: number | null,
): void {
  if (memory.source !== "/proc" || cgroupBytes === null) {
    cgroupAccountingWarned.delete(serverId);
    return;
  }
  if (cgroupAccountingWarned.has(serverId)) return;
  cgroupAccountingWarned.add(serverId);
  const entry = managed.get(serverId);
  if (entry) {
    entry.state.enforcementMessage =
      "Memory/CPU limits are cgroup settings, but this host's cgroup is not charging the server's "
      + "memory — usage is read from the process instead.";
    systemLine(serverId,
      "This host's cgroup reports far less memory than the JVM holds (a partially delegated "
      + "memory controller in a container). Memory usage is read from /proc instead; the limits "
      + "themselves are still configured.",
    );
  }
}

function startMetrics(serverId: number, entry: ManagedProcess): void {
  stopMetrics(serverId);
  entry.state.console.push({ ts: Date.now(), stream: "system", text: `Metric sampling started (${METRIC_INTERVAL_MS / 1000}s interval).` });
  entry.metricTimer = setInterval(() => void sampleMetrics(serverId, entry), METRIC_INTERVAL_MS);
}

function stopMetrics(serverId: number): void {
  const entry = managed.get(serverId);
  if (entry?.metricTimer) {
    clearInterval(entry.metricTimer);
    entry.metricTimer = undefined;
  }
}

async function sampleMetrics(serverId: number, entry: ManagedProcess): Promise<void> {
  const server = queryOne<ServerRow>("SELECT * FROM servers WHERE id = ?", [serverId]);
  if (!server || !entry.state.pid) return;

  const snapshot = sampleProcess(entry.state.pid, null);
  const cgroup = process.platform === "linux" ? readUsage(serverId) : null;
  // cgroup when it is genuinely accounting for the process, /proc otherwise — never a number the
  // host cannot back up (see resolveMemoryUsage).
  const memory = resolveMemoryUsage(cgroup?.memoryBytes, snapshot.rssBytes);
  const memBytes = memory.bytes;
  noteCgroupAccounting(serverId, memory, cgroup?.memoryBytes ?? null);
  const cpuPercent = snapshot.cpuPercent ?? 0;
  entry.lastCpu = cpuPercent;

  const now = Date.now();
  if (now - entry.lastDiskSample > DISK_SAMPLE_MS) {
    entry.diskBytes = directorySizeSync(serverDirFor(server.uuid));
    entry.lastDiskSample = now;
  }

  const players = entry.state.players.size;
  const metrics: ServerMetrics = {
    ts: now,
    cpuPercent: Number(cpuPercent.toFixed(2)),
    cpuSource: snapshot.source,
    memBytes,
    memCacheBytes: cgroup?.memoryCacheBytes ?? 0,
    diskBytes: entry.diskBytes,
    players,
    netRxBytes: 0,
    netTxBytes: 0,
    uptimeSeconds: uptimeSeconds(serverId),
    tps: null,
  };

  bus.publish(serverTopic(serverId), { type: "metrics", serverId, metrics });

  if (now - entry.lastPersist > METRIC_PERSIST_MS) {
    entry.lastPersist = now;
    insert(
      `INSERT INTO server_metrics (server_id, ts, cpu_percent, mem_bytes, disk_bytes, players)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [serverId, now, metrics.cpuPercent, metrics.memBytes, metrics.diskBytes, metrics.players],
    );
  }
}

export function currentMetrics(serverId: number): ServerMetrics {
  const entry = ensureEntry(serverId);
  const server = getServerRow(serverId);
  // peekProcess, not sampleProcess: reading state must not shorten the ticker's CPU window.
  const peek = entry.state.pid ? peekProcess(entry.state.pid) : null;
  const cgroup = entry.state.pid && process.platform === "linux" ? readUsage(serverId) : null;
  return {
    ts: Date.now(),
    // A stopped server has no CPU usage; keeping the last sample would show a dead process at 99%.
    cpuPercent: entry.state.pid ? Number(entry.lastCpu.toFixed(2)) : 0,
    cpuSource: peek ? peek.source : "stopped",
    memBytes: entry.state.pid ? resolveMemoryUsage(cgroup?.memoryBytes, peek?.rssBytes).bytes : 0,
    memCacheBytes: entry.state.pid && resolveMemoryUsage(cgroup?.memoryBytes, peek?.rssBytes).cgroupTrusted
      ? (cgroup?.memoryCacheBytes ?? 0)
      : 0,
    diskBytes: entry.diskBytes || directorySizeSync(serverDirFor(server.uuid)),
    players: entry.state.players.size,
    netRxBytes: 0,
    netTxBytes: 0,
    uptimeSeconds: uptimeSeconds(serverId),
    tps: null,
  };
}

export function runtimeState(serverId: number): RuntimeState {
  const entry = ensureEntry(serverId);
  const server = queryOne<{ status: string }>("SELECT status FROM servers WHERE id = ?", [serverId]);
  if (server && !entry.process) {
    // Keep the database as the source of truth for non-running servers.
    const valid: ServerStatus[] = ["offline", "crashed", "error", "installing", "stopping"];
    if (valid.includes(server.status as ServerStatus) && entry.state.status !== server.status) {
      entry.state.status = server.status as ServerStatus;
    }
  }
  return entry.state;
}

export function isRunning(serverId: number): boolean {
  return Boolean(managed.get(serverId)?.process);
}

/* ------------------------------------------------------------------ */
/* Orphan reconciliation                                               */
/* ------------------------------------------------------------------ */

/**
 * Adopts (or buries) JVMs that run a server directory without being in the process table.
 *
 * Without this, a panel restart left the UI showing whatever status was persisted last — typically
 * `error` from a failed reinstall — while the orphaned server kept running and eating CPU, so the
 * page claimed "Installation failed" next to live metrics. Adopted processes are reported as
 * `recovering` with an explicit explanation, and can be force-killed (no stdin pipe exists).
 */
export function reconcileForeignProcesses(): { adopted: number; released: number } {
  let adopted = 0;
  let released = 0;
  const rows = query<{ id: number; uuid: string; name: string }>("SELECT id, uuid, name FROM servers");
  const seen = new Set<number>();
  for (const row of rows) {
    seen.add(row.id);
    const entry = managed.get(row.id);
    if (entry?.process) continue;                       // tracked, nothing to do
    if (entry?.state.status === "installing") continue; // installer owns the directory

    if (entry?.state.foreign && entry.state.pid) {
      if (!isProcessAlive(entry.state.pid)) {
        entry.state.pid = null;
        entry.state.startedAt = null;
        entry.state.foreign = false;
        systemLine(row.id, "The adopted Java process has exited.");
        setStatus(row.id, "offline");
        released += 1;
      }
      continue;
    }

    const found = findJavaProcessForDirectory(serverDirFor(row.uuid));
    if (!found) continue;
    const target = ensureEntry(row.id);
    target.state.pid = found.pid;
    target.state.startedAt = found.startedAt;
    target.state.foreign = true;
    target.state.ready = false;
    setStatus(row.id, "recovering");
    systemLine(
      row.id,
      `Adopted an existing Java process (pid ${found.pid}) that is running this server's directory but was not started by RSLMC. `
      + "Its console output cannot be captured; use Force kill and then Start to hand control back to the panel.",
    );
    recordActivity({ type: "server.orphan_adopted", serverId: row.id, target: row.name, metadata: { pid: found.pid } });
    adopted += 1;
  }
  // Forget entries for servers that no longer exist.
  for (const key of [...managed.keys()]) if (!seen.has(key)) managed.delete(key);
  invalidateForeignProcessCache();
  return { adopted, released };
}

/* ------------------------------------------------------------------ */
/* Installation                                                        */
/* ------------------------------------------------------------------ */

export interface CreateServerOptions {
  uuid: string;
  software: string;
  mcVersion: string;
  memoryMb: number;
  cpuPercent: number;
  directory: string;
  javaMajor: number;
  serverId: number;
  onProgress?: (stage: string, received: number, total: number) => void;
}

export async function installServer(opts: CreateServerOptions): Promise<{ jarFile: string; version: string; build: string | null; sha256: string | null; source: string; javaMajor: number }> {
  const runtime = await ensureRuntime(opts.javaMajor);
  const executable = resolveExecutable(runtime);
  if (!executable) throw new ApiException(500, "java_missing", "Java runtime could not be installed");
  const result = await installServerSoftware({
    software: opts.software as any,
    version: opts.mcVersion,
    directory: opts.directory,
    javaExecutable: executable,
    serverId: opts.serverId,
    onProgress: opts.onProgress,
  });
  insert(
    `INSERT INTO installed_software (server_id, kind, name, version, build, source, sha256, file_name)
     VALUES (?, 'server', ?, ?, ?, ?, ?, ?)`,
    [opts.serverId, opts.software, result.version, result.build, result.source, result.sha256, result.jarFile],
  );
  return {
    jarFile: result.jarFile, version: result.version, build: result.build,
    sha256: result.sha256, source: result.source, javaMajor: result.javaMinimum,
  };
}

/** Set while the panel itself is going down: exits are not crashes in that case. */
let shuttingDown = false;

export function isShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * Stops every managed server. The panel asks each server to `stop` first and only escalates to
 * a kernel kill after the grace period, so a panel restart does not look like a crash in the
 * audit log or spam crash notifications.
 */
/**
 * Reconnects to servers that are still running under their relay from a *previous* panel process.
 *
 * This is the other half of "Restart RSLMC does not stop a single server": the old panel detaches,
 * the new panel calls this during boot, and every server is back in the process table with its live
 * console, its pid and its metrics — never having been stopped.
 */
export async function adoptRelays(): Promise<{ adopted: number; failed: number }> {
  let adopted = 0;
  let failed = 0;
  const rows = query<{ id: number; uuid: string; name: string }>("SELECT id, uuid, name FROM servers");
  for (const row of rows) {
    const existing = managed.get(row.id);
    if (existing?.process) continue;
    if (existing?.state.status === "installing") continue;
    const state = readRelayState(row.id);
    if (!state) continue;
    if (!isRelayAlive(state)) {
      cleanRelayFiles(row.id);
      continue;
    }
    const connection = await attachRelay(row.id, row.uuid, {
      onLine: (line) => pushLine(row.id, {
        ts: line.ts,
        stream: line.stream === "system" ? "stdout" : line.stream,
        text: line.text,
      }),
      onExit: (code, signal) => handleExit(row.id, code, signal),
      onNotice: (message) => systemLine(row.id, `Relay: ${message}`),
    });
    if (!connection) {
      failed += 1;
      continue;
    }
    const entry = ensureEntry(row.id);
    entry.process = connection;
    entry.relay = connection;
    entry.stoppingRequested = false;
    entry.restarting = false;
    entry.state.relayed = true;
    entry.state.foreign = false;
    entry.state.pid = connection.pid;
    entry.state.startedAt = state.startedAt ?? Date.now();
    entry.state.exitCode = null;
    entry.state.ready = true;
    entry.state.lastError = null;
    setStatus(row.id, "online");
    startMetrics(row.id, entry);
    systemLine(
      row.id,
      `Console reconnected (pid ${connection.pid ?? "?"}). This server kept running while RSLMC restarted, and the panel took its console back.`,
    );
    recordActivity({
      type: "server.relay_adopted", serverId: row.id, target: row.name,
      metadata: { pid: connection.pid, relay: connection.state.relayPid },
    });
    adopted += 1;
  }
  return { adopted, failed };
}

/**
 * Runs before the panel process exits for a restart. The opposite of `shutdownAll()`: servers are
 * left running, every relay connection is closed cleanly (the relay keeps the JVM alive), and no
 * server is marked offline. Console history is already on disk, so nothing is lost.
 */
export function handOffForPanelRestart(): { serversKept: number; relayed: number } {
  let serversKept = 0;
  let relayed = 0;
  for (const [, entry] of managed) {
    if (!entry.process) continue;
    serversKept += 1;
    if (entry.relay) relayed += 1;
    if (entry.flushTimer) { clearTimeout(entry.flushTimer); entry.flushTimer = undefined; }
    const pending = entry.pendingLines.splice(0, entry.pendingLines.length);
    if (pending.length > 0) bus.publish(serverTopic(entry.state.serverId), { type: "console", serverId: entry.state.serverId, lines: pending });
    stopMetrics(entry.state.serverId);
    try { entry.relay?.disconnect(); } catch { /* ignore */ }
    entry.relay = null;
    entry.process = null; // the next panel process re-attaches; we must not report a process we no longer hold
  }
  return { serversKept, relayed };
}

/** How many servers are currently running (used by the restart dialog and the boot report). */
export function runningServerCount(): number {
  return [...managed.values()].filter((entry) => Boolean(entry.process)).length;
}

export function shutdownAll(): void {
  shuttingDown = true;
  for (const [serverId, entry] of managed) {
    entry.stoppingRequested = true;
    try {
      if (entry.process) {
        setStatus(serverId, "stopping");
        systemLine(serverId, "Panel shutdown requested — sending stop.");
        sendCommandRaw(serverId, "stop");
        setTimeout(() => killCgroup(serverId), 8000);
      }
    } catch { /* ignore */ }
    stopMetrics(serverId);
    if (entry.flushTimer) clearTimeout(entry.flushTimer);
    if (entry.stopTimer) clearTimeout(entry.stopTimer);
  }
}

/** Waits (bounded) until every managed server has left the running state. */
export async function waitForIdle(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const busy = [...managed.values()].some((entry) =>
      entry.process !== null || ["online", "starting", "stopping", "restarting", "recovering"].includes(entry.state.status));
    if (!busy) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export function listManaged(): { serverId: number; status: ServerStatus; pid: number | null }[] {
  return [...managed.entries()].map(([serverId, entry]) => ({
    serverId, status: entry.state.status, pid: entry.state.pid,
  }));
}

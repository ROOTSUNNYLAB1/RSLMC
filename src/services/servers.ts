import { networkInterfaces } from "node:os";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { query, queryOne, run, insert, transaction } from "../database";
import { serverDir, PATHS } from "../shared/config";
import { ApiException } from "../shared/http";
import { MIN_ALLOCATION_MB, MAX_ALLOCATION_MB } from "../shared/memory";
import { playAddress, normalisePublicHost, validatePublicPort } from "../shared/address";
import { describeEnforcement } from "../resources/enforcement";
import { cpuBudget } from "../resources/cpu-budget";
import { getNode, nodeRequestOrThrow, createLink, linkForServer, dropLink } from "../nodes/client";
import { javaMajorForMcVersion } from "../minecraft/java-requirements";
import { defaultJvmArgsFor } from "../minecraft/jvm-presets";
import type { ServerSoftwareId } from "../shared/types";
import { installServer, currentMetrics, runtimeState, uptimeSeconds, isRunning, getServerRow, invalidateServerCaches, systemLine } from "../processes/manager";
import { peekProcess } from "../resources/process-stats";
import { recordActivity } from "./audit";
import { bus, serverTopic } from "../events/bus";
import { writeFileAtomic } from "./download";
import { softwareDefinition, minimumJavaFor } from "../minecraft/providers";
import { normalizeBindIp, isValidPort, isTcpPortFree } from "./net";
import { ensureRuntime, resolveExecutable, runtimeInfo } from "../java/manager";
import { notify } from "./notifications";
import { containerNameFor, probeDocker, removeContainer } from "../runtime/docker";
import { appImageFor, imageForMajor, yolksAllTags, yolksJavaTags } from "../runtime/images";
import { APP_FAMILIES, appDisplayName, isAppSoftware, type AppFamily } from "../apps/catalog";
import { ensureInterpreter, installAppScaffold, interpreterExecutable } from "../apps/interpreters";
import { normaliseEntryFile, validateEntryFile } from "../apps/launch";
import { panelCanSwitchUser, requiresIsolation, serviceAccountState } from "../runtime/nonroot";
import type { ServerSummary, ServerStatus, UserPublic } from "../shared/types";

export function mapServer(row: any): ServerSummary {
  const node = queryOne<{ name: string }>("SELECT name FROM nodes WHERE id = ?", [row.node_id]);
  const owner = queryOne<{ username: string }>("SELECT username FROM users WHERE id = ?", [row.owner_id]);
  const state = runtimeState(row.id);
  /*
   * An adopted (foreign) JVM has no `process` handle, so isRunning() is false even though the
   * server is up. Treat it as live, otherwise the page shows the stale database status — which is
   * exactly how "Installation failed / ERROR" ended up next to a server burning 176 % CPU.
   */
  const live = isRunning(row.id) || state.foreign;
  const playersOnline = live ? state.players.size : 0;
  const runtime = row.java_runtime_id
    ? queryOne<{ major: number; version: string }>("SELECT major, version FROM java_runtimes WHERE id = ?", [row.java_runtime_id])
    : null;
  const properties = queryOne<{ c: number }>("SELECT COUNT(*) AS c FROM players WHERE server_id = ? AND online = 1", [row.id]);

  let enforcement: ServerSummary["enforcement"] = null;
  try {
    const stored = row.enforcement ? JSON.parse(row.enforcement) : null;
    enforcement = stored ?? describeEnforcement();
  } catch {
    enforcement = describeEnforcement();
  }
  /*
   * The stored notes describe the JVM: `-Xms/-Xmx` below the cgroup cap. A Python or Node process never
   * sees those flags, so the note is rewritten to describe what is actually true for it — otherwise the
   * server page would explain a heap that does not exist.
   */
  if (enforcement && isAppSoftware(row.software)) {
    const node = row.software === "node";
    enforcement = {
      ...enforcement,
      memory: {
        ...enforcement.memory,
        note: enforcement.memory.level === "enforced"
          ? `Total process memory is capped by the kernel for the server's cgroup${node ? `; Node is started with --max-old-space-size=${Math.max(64, Math.round((row.memory_mb ?? 0) * 0.75))} MB, derived from the same allocation` : "; Python has no heap flag, the cap applies to the whole process tree"}.`
          : `${enforcement.memory.note.replace(/RSLMC sets -Xms\/-Xmx[^.]*\./g, "")} This host cannot enforce it, so the panel reports real usage without claiming a cap.`.trim(),
      },
    };
  }

  return {
    id: row.id,
    uuid: row.uuid,
    name: row.name,
    description: row.description,
    icon: row.icon,
    status: (live ? state.status : row.status) as ServerStatus,
    software: row.software,
    softwareVersion: row.software_version ?? "",
    mcVersion: row.mc_version,
    nodeId: row.node_id,
    nodeName: node?.name,
    ownerId: row.owner_id,
    ownerName: owner?.username,
    runtime: (row.runtime ?? "standalone") as "standalone" | "docker",
    dockerImage: row.docker_image ?? null,
    containerName: row.runtime === "docker" ? `rslmc-${row.uuid}` : null,
    dockerDiskQuota: Boolean(row.docker_disk_quota),
    memoryMb: row.memory_mb,
    cpuPercent: row.cpu_percent,
    diskMb: row.disk_mb,
    bindIp: row.bind_ip,
    port: row.port,
    publicHost: row.public_host ?? null,
    publicPort: row.public_port ?? null,
    // Kept for compatibility: `address` is the player-facing one everywhere in the UI.
    address: playAddress(
      { bindIp: row.bind_ip, port: row.port, publicHost: row.public_host, publicPort: row.public_port },
      row.bind_ip === "0.0.0.0" || row.bind_ip === "::" ? publicAddress() : row.bind_ip,
    ),
    internalAddress: `${row.bind_ip === "0.0.0.0" || row.bind_ip === "::" ? publicAddress() : row.bind_ip}:${row.port}`,
    playAddress: playAddress(
      { bindIp: row.bind_ip, port: row.port, publicHost: row.public_host, publicPort: row.public_port },
      row.bind_ip === "0.0.0.0" || row.bind_ip === "::" ? publicAddress() : row.bind_ip,
    ),
    javaMajor: runtime?.major ?? row.java_major,
    javaRuntimeId: row.java_runtime_id,
    /*
     * Python/Node servers report what actually starts them. `installed` is measured on disk, not
     * copied from the database: an interpreter removed by hand must show as missing before the
     * operator presses Start and gets an error.
     */
    app: isAppSoftware(row.software) ? (() => {
      const family = row.software as AppFamily;
      const definition = APP_FAMILIES[family];
      const executable = interpreterExecutable(family, row.mc_version);
      const state = serviceAccountState();
      return {
        family,
        name: definition.name,
        version: row.mc_version,
        entryFile: row.entry_file?.trim() || definition.entryFile,
        interpreterPath: executable,
        installed: executable !== null,
        binary: definition.binary,
        serviceUser: requiresIsolation(row.software) && state.exists ? state.user : null,
        isolated: requiresIsolation(row.software) && state.exists && state.canIsolate,
      };
    })() : null,
    autoStart: row.auto_start === 1,
    crashRecovery: row.crash_recovery === 1,
    createdAt: row.created_at,
    lastStartedAt: row.last_started_at,
    installedAt: row.installed_at,
    usage: (() => {
      if (!live) return null;
      /*
       * A container server has no useful `/proc` entry: `state.pid` is the relay (or the CLI), so a
       * process-tree read reported 7 MB for a JVM the daemon measured at 428 MiB. The container's own
       * accounting is the only honest number, and it is what the memory limit is enforced against.
       */
      if (row.runtime === "docker") {
        const metrics = currentMetrics(row.id);
        return { cpuPercent: metrics.cpuPercent, memBytes: metrics.memBytes, cpuSource: metrics.cpuSource ?? "docker" };
      }
      if (!state.pid) return null;
      const peek = peekProcess(state.pid);
      return { cpuPercent: peek.cpuPercent, memBytes: peek.rssBytes, cpuSource: peek.source };
    })(),
    uptimeSeconds: live ? uptimeSeconds(row.id) : 0,
    playersOnline: live ? playersOnline : (properties?.c ?? 0),
    maxPlayers: Number(
      readMaxPlayers(row) ?? 20,
    ),
    enforcement,
    cpuBudget: row.runtime === "docker"
      ? (() => {
          const budget = cpuBudget(row.cpu_percent, probeDocker().cpuCount);
          return {
            requestedCores: budget.requestedCores, grantedCores: budget.grantedCores,
            hostCores: budget.hostCores, clamped: budget.clamped, source: budget.source,
          };
        })()
      : null,
  };
}

function readMaxPlayers(row: any): number | null {
  try {
    const path = join(serverDir(row.uuid), "server.properties");
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "utf8");
    const match = /^max-players=(\d+)/m.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

let cachedPublicAddress: string | null = null;
export function publicAddress(): string {
  if (cachedPublicAddress) return cachedPublicAddress;
  cachedPublicAddress = process.env.RSLMC_PUBLIC_HOST?.trim() || detectLocalAddress();
  return cachedPublicAddress;
}

function detectLocalAddress(): string {
  // Prefer the first non-internal IPv4 address of the host; this works on every platform.
  try {
    const nets = networkInterfaces();
    for (const addresses of Object.values(nets)) {
      for (const address of addresses ?? []) {
        if (address.family === "IPv4" && !address.internal) return address.address;
      }
    }
  } catch { /* ignore */ }
  if (process.platform === "linux" || process.platform === "darwin") {
    try {
      const result = Bun.spawnSync(["sh", "-c", "ip route get 1.1.1.1 2>/dev/null | head -1 | awk '{print $7}'"], { stdout: "pipe", stderr: "ignore" });
      const ip = result.stdout.toString().trim();
      if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
    } catch { /* ignore */ }
  }
  return "127.0.0.1";
}

export function listServersForUser(user: UserPublic): ServerSummary[] {
  const rows = user.isRoot
    ? query("SELECT * FROM servers ORDER BY id")
    : query(
      `SELECT DISTINCT s.* FROM servers s
       LEFT JOIN server_subusers su ON su.server_id = s.id
       WHERE s.owner_id = ? OR su.user_id = ? ORDER BY s.id`,
      [user.id, user.id],
    );
  return rows.map(mapServer);
}

/* ------------------------------------------------------------------ */
/* Server allocation: who may see and control a server                 */
/* ------------------------------------------------------------------ */

export type ServerRelation = "owner" | "shared" | "none";

export interface UserServerEntry {
  id: number;
  name: string;
  software: string;
  mcVersion: string;
  status: string;
  relation: ServerRelation;
  ownerName: string | null;
}

/** Every server on the panel with this account's relation to it, for the admin allocation screen. */
export function listServersForAllocation(userId: number): UserServerEntry[] {
  const rows = query<any>("SELECT * FROM servers ORDER BY name COLLATE NOCASE");
  const shared = new Set(
    query<{ server_id: number }>("SELECT server_id FROM server_subusers WHERE user_id = ?", [userId]).map((row) => row.server_id),
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    software: row.software,
    mcVersion: row.mc_version,
    status: runtimeState(row.id).status ?? row.status,
    relation: row.owner_id === userId ? "owner" : shared.has(row.id) ? "shared" : "none",
    ownerName: queryOne<{ username: string }>("SELECT username FROM users WHERE id = ?", [row.owner_id])?.username ?? null,
  }));
}

export interface AllocationInput {
  owner?: number[];
  shared?: number[];
  /** Optional narrowing for a shared server: `{ [serverId]: Permission[] }`. */
  scope?: Record<number, string[]>;
  /** Where a server goes when it is taken away from this account (servers always need an owner). */
  reassignOwnerTo?: number | null;
}

/**
 * The permissions a shared grant carries on one server.
 *
 * Defaults to everything the account's *role* grants for that server, so a share behaves like before
 * for the common case — but it is written down, so an administrator can see it and narrow it.
 */
function scopeFor(userId: number, serverId: number, override?: string[]): string[] {
  if (override) return override;
  const rolePermissions = new Set(
    query<{ permission: string }>(
      "SELECT DISTINCT rp.permission FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = ?",
      [userId],
    ).map((row) => row.permission),
  );
  return [...rolePermissions].filter((permission) => permission.startsWith("server.") || permission === "*");
}

/**
 * Sets exactly which servers an account owns and which it can share.
 *
 * Ownership moves between accounts (a server always has exactly one owner), shared access is a
 * plain grant. Extra keys in either list are treated as "remove", and a server cannot be both.
 * Returns what actually changed so the caller can audit it honestly.
 */
export function setUserServerAccess(userId: number, input: AllocationInput): {
  owned: number[];
  shared: number[];
  ownerAdded: number[];
  ownerRemoved: number[];
  sharedAdded: number[];
  sharedRemoved: number[];
} {
  const user = queryOne<{ id: number; username: string; is_root: number }>(
    "SELECT id, username, is_root FROM users WHERE id = ?", [userId],
  );
  if (!user) throw new ApiException(404, "user_not_found", "User not found");

  const all = new Set(query<{ id: number }>("SELECT id FROM servers").map((row) => Number(row.id)));
  const wantedOwner = new Set((input.owner ?? []).map(Number));
  const wantedShared = new Set((input.shared ?? []).map(Number));
  for (const id of wantedOwner) {
    if (!all.has(id)) throw new ApiException(400, "unknown_server", `Server ${id} does not exist`);
    if (wantedShared.has(id)) throw new ApiException(400, "overlapping_allocation", `Server ${id} cannot be both owned and shared`);
  }
  for (const id of wantedShared) {
    if (!all.has(id)) throw new ApiException(400, "unknown_server", `Server ${id} does not exist`);
  }

  const ownerAdded: number[] = [];
  const ownerRemoved: number[] = [];
  const sharedAdded: number[] = [];
  const sharedRemoved: number[] = [];

  transaction(() => {
    // 1. Ownership. A server owned by somebody else stays theirs unless it is explicitly listed.
    for (const row of query<{ id: number; owner_id: number }>("SELECT id, owner_id FROM servers")) {
      const id = Number(row.id);
      if (wantedOwner.has(id) && row.owner_id !== userId) {
        if (user.is_root === 1) {
          // Root already owns everything; ownership is meaningless for them.
          continue;
        }
        run("UPDATE servers SET owner_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", [userId, id]);
        ownerAdded.push(id);
      } else if (!wantedOwner.has(id) && row.owner_id === userId) {
        /*
         * Ownership is being taken away. servers.owner_id is NOT NULL, so the server has to land on
         * somebody: the acting administrator is passed in by the route through `reassignOwnerTo`.
         */
        const fallback = input.reassignOwnerTo ?? null;
        if (fallback && fallback !== userId) {
          run("UPDATE servers SET owner_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", [fallback, id]);
          ownerRemoved.push(id);
        }
      }
    }

    // 2. Shared access.
    const currentShared = new Set(
      query<{ server_id: number }>("SELECT server_id FROM server_subusers WHERE user_id = ?", [userId]).map((row) => Number(row.server_id)),
    );
    for (const id of wantedShared) {
      /*
       * The scope is written explicitly, and re-written on a share that already exists.
       *
       * `permissions` used to be left NULL and never read, so a shared grant silently meant "the
       * account's whole role on this server". `scopeFor` narrows a share to the server-level
       * permissions the role actually has — the administrator can tighten it further through
       * `PUT /api/users/:id/servers` by passing `scope`.
       *
       * This used to `continue` when the share was already there, so changing somebody's scope on a
       * server they already had access to wrote nothing: the panel reported `shared: [1]` and the
       * scope stayed at its old value. Widening or narrowing is the whole point of the control.
       */
      const alreadyShared = currentShared.has(id);
      const permissions = JSON.stringify(scopeFor(userId, id, input.scope?.[id]));
      run(
        "INSERT INTO server_subusers (server_id, user_id, permissions) VALUES (?, ?, ?) "
        + "ON CONFLICT(server_id, user_id) DO UPDATE SET permissions = excluded.permissions",
        [id, userId, permissions],
      );
      if (!alreadyShared) sharedAdded.push(id);
    }
    for (const id of currentShared) {
      if (wantedShared.has(id)) continue;
      run("DELETE FROM server_subusers WHERE server_id = ? AND user_id = ?", [id, userId]);
      sharedRemoved.push(id);
    }

    // A newly owned server no longer needs a shared grant.
    for (const id of ownerAdded) {
      if (currentShared.has(id)) {
        run("DELETE FROM server_subusers WHERE server_id = ? AND user_id = ?", [id, userId]);
        sharedRemoved.push(id);
      }
    }
  });

  return { owned: [...wantedOwner], shared: [...wantedShared], ownerAdded, ownerRemoved, sharedAdded, sharedRemoved };
}

export function getServer(serverId: number): ServerSummary {
  const row = queryOne("SELECT * FROM servers WHERE id = ?", [serverId]);
  if (!row) throw new ApiException(404, "server_not_found", "Server not found");
  return mapServer(row);
}

export interface CreateServerInput {
  name: string;
  description?: string;
  ownerId: number;
  nodeId: number;
  software: string;
  mcVersion: string;
  memoryMb: number;
  cpuPercent: number;
  diskMb: number;
  bindIp: string;
  port: number;
  javaMajor?: number;
  jvmArgs?: string;
  /** Optional tunnel / public hostname (playit.gg, ngrok, …). */
  publicHost?: string | null;
  publicPort?: number | null;
  serverArgs?: string;
  autoStart?: boolean;
  crashRecovery?: boolean;
  acceptEula: boolean;
  icon?: string;
  install?: boolean;
  /** `standalone` (a JVM the panel starts) or `docker` (a container). */
  runtime?: "standalone" | "docker";
  /** Java image to run in the container; resolved from the major when omitted. */
  dockerImage?: string | null;
  /**
   * Python/Node only: the file the interpreter starts, relative to the server directory.
   * Defaults to `main.py` / `index.js`.
   */
  entryFile?: string;
}

/**
 * Reserves a port on a node.
 *
 * `allocations` is unique per (node, ip, port), and rows survive server deletion in older
 * builds. So instead of blindly inserting (which produced
 * "UNIQUE constraint failed: allocations.node_id, allocations.ip, allocations.port"),
 * we claim a free / orphaned row and only fail when a live server really owns the port.
 */
function reserveAllocation(nodeId: number, ip: string, port: number, serverId: number, note: string): void {
  const existing = queryOne<{ id: number; server_id: number | null }>(
    "SELECT id, server_id FROM allocations WHERE node_id = ? AND ip = ? AND port = ?",
    [nodeId, ip, port],
  );
  let allocationId: number;
  if (!existing) {
    allocationId = insert("INSERT INTO allocations (node_id, ip, port, server_id, notes) VALUES (?, ?, ?, ?, ?)", [
      nodeId, ip, port, serverId, note,
    ]);
  } else if (existing.server_id == null) {
    run("UPDATE allocations SET server_id = ?, notes = ? WHERE id = ?", [serverId, note, existing.id]);
    allocationId = existing.id;
  } else {
    const owner = queryOne<{ id: number; name: string }>("SELECT id, name FROM servers WHERE id = ?", [existing.server_id]);
    if (owner) {
      throw new ApiException(
        409, "allocation_conflict",
        `Port ${port} on ${ip} is already allocated to the server "${owner.name}" (#${owner.id}). Pick another port.`,
      );
    }
    // Orphaned allocation from a server that no longer exists — reclaim it.
    run("UPDATE allocations SET server_id = ?, notes = ? WHERE id = ?", [serverId, note, existing.id]);
    allocationId = existing.id;
  }
  // `allocations.server_id` and `server_allocations` both describe "who owns this port". Only the
  // first was ever written, so the join table stayed empty and releaseAllocations() was deleting
  // from a table that nothing filled. Keep the two in step: this call always claims the primary port.
  run(
    `INSERT INTO server_allocations (server_id, allocation_id, primary_port) VALUES (?, ?, 1)
     ON CONFLICT(server_id, allocation_id) DO UPDATE SET primary_port = 1`,
    [serverId, allocationId],
  );
}

/** Releases every port allocation owned by a server. */
export function releaseAllocations(serverId: number): void {
  run("DELETE FROM server_allocations WHERE server_id = ?", [serverId]);
  run("DELETE FROM allocations WHERE server_id = ?", [serverId]);
}

/**
 * Creates the database record, allocates the port, prepares the directory and then performs a
 * real installation (Java runtime + server software download) in the background with progress
 * reported over WebSockets.
 */
export async function createServer(input: CreateServerInput, actor: string): Promise<{ server: ServerSummary; installId: string }> {
  const definition = softwareDefinition(input.software as any);
  /*
   * Python and Node.js have no EULA and no Minecraft version: the "version" is the interpreter line.
   * Everything else in this function (allocation, limits, directory, row) is deliberately identical, so
   * an app server is a first-class server rather than a second kind of record.
   */
  const isApp = isAppSoftware(input.software);
  if (!isApp && !input.acceptEula) {
    throw new ApiException(400, "eula_required", "You must accept the Minecraft EULA to create a server");
  }
  let entryFile: string | null = null;
  if (isApp) {
    const family = input.software as AppFamily;
    const problem = validateEntryFile(input.entryFile ?? "", family);
    if (problem) throw new ApiException(400, "invalid_entry_file", problem.message);
    entryFile = normaliseEntryFile(input.entryFile ?? "", family);
    // Refuse a version that does not exist for this platform at creation time, not at first start.
    const { listAppVersions } = await import("../apps/catalog");
    const versions = await listAppVersions(family).catch(() => []);
    const match = versions.find((version) => version.version === input.mcVersion);
    if (versions.length > 0 && !match) {
      throw new ApiException(400, "version_unavailable",
        `${definition.name} ${input.mcVersion} is not published for this machine by ${APP_FAMILIES[family].source}.`);
    }
    if (match?.unavailableReason) {
      throw new ApiException(400, "version_unavailable", `${definition.name} ${input.mcVersion}: ${match.unavailableReason}`);
    }
  }
  if (!/^[A-Za-z0-9 _.\-]{2,60}$/.test(input.name)) throw new ApiException(400, "invalid_name", "Server name may contain letters, numbers, spaces, dot, dash and underscore");
  if (input.memoryMb < MIN_ALLOCATION_MB) {
    throw new ApiException(400, "invalid_memory", `Memory must be at least ${MIN_ALLOCATION_MB} MB`);
  }
  if (input.cpuPercent < 10 || input.cpuPercent > 1600) throw new ApiException(400, "invalid_cpu", "CPU allocation must be between 10% and 1600%");

  let bindIp: string;
  try { bindIp = normalizeBindIp(input.bindIp); } catch (err) {
    throw new ApiException(400, "invalid_bind_ip", err instanceof Error ? err.message : "Invalid bind address");
  }
  if (!isValidPort(input.port)) throw new ApiException(400, "invalid_port", "Port must be between 1 and 65535");
  let publicHost: string | null;
  let publicPort: number | null;
  try {
    publicHost = normalisePublicHost(input.publicHost);
    publicPort = validatePublicPort(input.publicPort);
  } catch (err) {
    throw new ApiException(400, "invalid_public_address", err instanceof Error ? err.message : "Invalid public address");
  }
  const node = queryOne<{ id: number; is_local: number; name: string; maintenance: number }>(
    "SELECT id, is_local, name, maintenance FROM nodes WHERE id = ?", [input.nodeId],
  );
  if (!node) throw new ApiException(400, "invalid_node", "Node not found");
  if (node.maintenance === 1) {
    throw new ApiException(409, "node_maintenance", `Node "${node.name}" is in maintenance mode and is not accepting new servers.`);
  }
  // A remote node's ports are its own: the local port probe above only proves the port is free here.
  const isRemote = node.is_local !== 1;

  // Only a local server can be probed from here; a remote node checks its own ports when it creates
  // the server (its answer is what decides, so the panel never claims a port it could not test).
  if (!isRemote && !(await isTcpPortFree(bindIp, input.port))) {
    throw new ApiException(409, "port_in_use", `Port ${input.port} is already in use on ${bindIp}`);
  }
  const duplicateAllocation = queryOne<{ id: number; name: string }>(
    "SELECT id, name FROM servers WHERE node_id = ? AND port = ? AND bind_ip = ?",
    [input.nodeId, input.port, bindIp],
  );
  if (duplicateAllocation) {
    throw new ApiException(
      409, "allocation_conflict",
      `Port ${input.port} on ${bindIp} is already used by the server "${duplicateAllocation.name}" (#${duplicateAllocation.id}). Pick another port.`,
    );
  }

  const owner = queryOne<{ id: number }>("SELECT id FROM users WHERE id = ?", [input.ownerId]);
  if (!owner) throw new ApiException(400, "invalid_owner", "Owner not found");

  // Non-JVM software has no Java major; 0 is stored so nothing renders "Java 0" anywhere.
  const javaMajor = isApp ? 0 : (input.javaMajor ?? javaMajorForMcVersion(input.mcVersion));
  // Optimised defaults instead of an empty flag list: Aikar's G1GC set for game servers, the small
  // proxy set for Velocity/BungeeCord, SerialGC on tiny heaps. A user-supplied string always wins.
  if (!isApp && input.jvmArgs && /-Xm[sx](\d|\s|=|$)/.test(input.jvmArgs)) {
    throw new ApiException(400, "memory_flags_in_jvm_args",
      "Remove -Xms / -Xmx from the JVM flags: the heap size comes from the memory allocation.");
  }
  if (!isApp && input.jvmArgs && HEAP_OVERRIDE_PATTERN.test(input.jvmArgs)) {
    throw new ApiException(400, "memory_flags_in_jvm_args",
      "Remove -XX:MaxHeapSize / -XX:InitialHeapSize / -XX:MaxRAMPercentage from the JVM flags: the heap size comes from the memory allocation.");
  }
  const jvmArgs = isApp ? "" : (input.jvmArgs?.trim() ? input.jvmArgs.trim() : defaultJvmArgsFor(input.software as ServerSoftwareId, input.memoryMb));
  const uuid = randomUUID();
  const enforcement = describeEnforcement();

  /*
   * Runtime choice. Docker is only accepted when a daemon actually answers, and the refusal names the
   * reason — offering a container server on a machine without Docker produces a record that can never
   * start, which is worse than saying no at the point of creation.
   */
  const runtime: "standalone" | "docker" = input.runtime === "docker" ? "docker" : "standalone";
  let dockerImage: string | null = null;
  if (runtime === "docker") {
    const docker = probeDocker();
    if (!docker.available) {
      throw new ApiException(409, "docker_unavailable",
        `This server was requested as a Docker container, but Docker is not usable here: ${docker.reason ?? "the daemon is not answering"}.`);
    }
    /*
     * Resolve against the registry's live tag list, so a yolks image is preferred when it exists and
     * the official image only when it does not. For Python/Node this is the difference between
     * `yolks:python_3.11` and `python:3.13-slim` — both correct, but the operator should know which.
     */
    dockerImage = input.dockerImage?.trim() || (isApp
      ? appImageFor(input.software as AppFamily, input.mcVersion, await yolksAllTags()).reference
      : imageForMajor(javaMajor, await yolksJavaTags()).reference);
  }

  // The server row and its allocation are written together: a failure here must not leave a
  // half-created server behind (that is what produced "duplicate" servers in earlier builds).
  const serverId = transaction(() => {
    const id = insert(
      `INSERT INTO servers (uuid, name, description, icon, owner_id, node_id, software, software_version, mc_version,
        java_major, status, memory_mb, cpu_percent, disk_mb, bind_ip, port, public_host, public_port,
        jvm_args, server_args, auto_start, crash_recovery, enforcement, eula_accepted, runtime, docker_image, entry_file)
       VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, 'installing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [
        uuid, input.name, input.description ?? null, input.icon ?? null, input.ownerId, input.nodeId,
        input.software, input.mcVersion, javaMajor, input.memoryMb, input.cpuPercent, input.diskMb,
        bindIp, input.port, publicHost, publicPort, jvmArgs,
        // `nogui` is a Minecraft flag; passing it to a Python program would be an argument it never asked for.
        input.serverArgs ?? (isApp ? "" : "nogui"),
        input.autoStart ? 1 : 0, input.crashRecovery ? 1 : 0, JSON.stringify(enforcement),
        runtime, dockerImage, entryFile,
      ],
    );
    reserveAllocation(input.nodeId, bindIp, input.port, id, `Primary allocation for ${input.name}`);
    return id;
  });

  if (isRemote) {
    /*
     * Remote node: the files live on that machine, so nothing is created here. The node builds the
     * server with its own installer and answers with the id it assigned; the link table remembers the
     * pair so every later request can be rewritten onto the node's own path.
     */
    const nodeRow = getNode(node.id)!;
    let created: { server?: { id: number; uuid?: string }; installId?: string };
    try {
      const response = await nodeRequestOrThrow(nodeRow, "/api/servers", {
        method: "POST",
        body: {
          name: input.name,
          description: input.description ?? undefined,
          // The node has its own accounts; its administrator owns everything created through the
          // controller, because ownership is decided by this panel, not that one.
          ownerId: 0,
          nodeId: 1,
          software: input.software,
          mcVersion: input.mcVersion,
          memoryMb: input.memoryMb,
          cpuPercent: input.cpuPercent,
          diskMb: input.diskMb,
          bindIp,
          port: input.port,
          publicHost: publicHost ?? undefined,
          publicPort: publicPort ?? undefined,
          javaMajor,
          jvmArgs: input.jvmArgs ?? "",
          serverArgs: input.serverArgs ?? "nogui",
          autoStart: input.autoStart ?? false,
          crashRecovery: input.crashRecovery ?? false,
          acceptEula: true,
        },
        timeoutMs: 30_000,
      });
      created = (response.body as any) ?? {};
    } catch (error) {
      // The node refused: roll the local record back so the two panels cannot disagree.
      run("DELETE FROM servers WHERE id = ?", [serverId]);
      releaseAllocations(serverId);
      throw new ApiException(
        502, "node_create_failed",
        `Node "${node.name}" refused the server: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const remoteId = created.server?.id;
    if (!remoteId) {
      run("DELETE FROM servers WHERE id = ?", [serverId]);
      releaseAllocations(serverId);
      throw new ApiException(502, "node_create_failed", `Node "${node.name}" did not return a server id.`);
    }
    createLink(serverId, node.id, remoteId, created.server?.uuid ?? uuid);
    recordActivity({
      type: "server.created", serverId, target: input.name, actorName: actor,
      metadata: { software: input.software, mcVersion: input.mcVersion, javaMajor, memoryMb: input.memoryMb, node: node.name },
    });
    return { server: getServer(serverId), installId: created.installId ?? `node-${remoteId}` };
  }

  const directory = serverDir(uuid);
  try {
    mkdirSync(directory, { recursive: true });
    /*
     * A Python or Node server gets none of the Minecraft files. Writing `server.properties` and an
     * empty `ops.json` into an app directory was harmless but confusing, and it made the panel treat
     * the directory as a Minecraft one in the file manager's "known file" list.
     */
    if (!isApp) {
      writeFileAtomic(join(directory, "server.properties"), initialServerProperties(input));
      writeFileAtomic(join(directory, "ops.json"), "[]\n");
      writeFileAtomic(join(directory, "whitelist.json"), "[]\n");
      writeFileAtomic(join(directory, "banned-players.json"), "[]\n");
      writeFileAtomic(join(directory, "banned-ips.json"), "[]\n");
    }
  } catch (error) {
    // Roll the record back: a server whose directory could not be prepared must not linger.
    run("DELETE FROM servers WHERE id = ?", [serverId]);
    releaseAllocations(serverId);
    rmSync(directory, { recursive: true, force: true });
    throw new ApiException(
      500, "create_failed",
      `Could not prepare the server directory: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  recordActivity({
    type: "server.created", serverId, target: input.name, actorName: actor,
    metadata: { software: input.software, mcVersion: input.mcVersion, javaMajor, memoryMb: input.memoryMb },
  });

  const installId = randomUUID();
  const server = getServer(serverId);
  if (input.install !== false) {
    if (isApp) {
      void runAppInstall(serverId, installId, input.software as AppFamily, input.mcVersion, entryFile!, directory);
    } else {
      void runInstall(serverId, installId, definition.name, input.mcVersion, javaMajor, directory, serverId);
    }
  }
  return { server, installId };
}

/**
 * Installation for a Python/Node server.
 *
 * There is nothing to download *into* the server directory: what has to exist is the interpreter, and
 * that is installed once per (family, version) and shared. So the work here is (1) make the interpreter
 * available, (2) scaffold an entry file the operator can immediately run, (3) hand the directory to the
 * service account so the sealed process can write its own files.
 *
 * The service account is created here rather than at boot because creating a system user is a real
 * change to the machine: it happens when an operator actually asks for a Python/Node server.
 */
async function runAppInstall(
  serverId: number,
  installId: string,
  family: AppFamily,
  version: string,
  entryFile: string,
  directory: string,
): Promise<void> {
  const definition = APP_FAMILIES[family];
  const publish = (label: string, progress: number, total: number, done = false, error?: string) => {
    bus.publish(serverTopic(serverId), {
      type: "progress", kind: "install", id: installId, label, progress, total, done, error,
    });
  };
  try {
    publish(`Preparing ${appDisplayName(family, version)}`, 0, 0);
    const interpreter = await ensureInterpreter(family, version, (stage, received, total) => publish(stage, received, total));

    publish(`Writing ${entryFile}`, 0, 0);
    await installAppScaffold(family, version, directory);
    run("UPDATE servers SET entry_file = ? WHERE id = ?", [entryFile, serverId]);

    /*
     * Hand the files to the service account. Only when it exists: on a host where the panel cannot
     * create or switch to another user, the server runs under the panel's account and the UI says so
     * instead of claiming isolation it does not have.
     */
    let isolationNote = "Runs under the panel's own account — this host cannot create a service account (the panel is not root).";
    if (panelCanSwitchUser()) {
      const { ensureServiceAccount, handOverDirectory } = await import("../runtime/nonroot");
      const ensured = ensureServiceAccount();
      if (ensured.state.exists) {
        const handed = handOverDirectory(directory, ensured.state);
        run("UPDATE servers SET service_user = ? WHERE id = ?", [ensured.state.user, serverId]);
        isolationNote = `Runs as ${ensured.state.user} (uid ${ensured.state.uid}) — the process cannot touch the panel's files or escalate.`
          + (handed.changed > 0 ? ` Ownership handed over for ${handed.changed} path${handed.changed === 1 ? "" : "s"}.` : "");
        if (ensured.password) isolationNote += ` A password was generated for ${ensured.state.user}; it is shown once on the Runtime page.`;
        for (const note of ensured.notes) systemLine(serverId, note);
      } else {
        isolationNote = ensured.state.reason ?? isolationNote;
      }
    }
    systemLine(serverId, isolationNote);

    const softwareVersion = interpreter.version;
    run(
      `UPDATE servers SET status = 'offline', installed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        software_version = ?, java_runtime_id = NULL, install_log = NULL WHERE id = ?`,
      [softwareVersion, serverId],
    );
    publish(`${appDisplayName(family, version)} ready`, 1, 1, true);
    recordActivity({
      type: "server.installed", serverId, target: version,
      metadata: { runtime: definition.name, interpreter: interpreter.path, entryFile },
    });
    notify({
      title: `Server installed: ${queryOne<{ name: string }>("SELECT name FROM servers WHERE id = ?", [serverId])?.name}`,
      body: `${appDisplayName(family, version)} is ready — ${entryFile} will be started when you press Start.`,
      severity: "success", kind: "server_installed", link: `/servers/${serverId}/overview`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[rslmc] app install failed for server #${serverId}: ${message}`);
    if (isRunning(serverId)) {
      run("UPDATE servers SET install_log = ? WHERE id = ?", [message.slice(0, 2000), serverId]);
    } else {
      run("UPDATE servers SET status = 'error', install_log = ? WHERE id = ?", [message.slice(0, 2000), serverId]);
    }
    publish("Installation failed", 0, 0, true, message.slice(0, 2000));
    notify({
      title: `Installation failed: ${queryOne<{ name: string }>("SELECT name FROM servers WHERE id = ?", [serverId])?.name}`,
      body: message.slice(0, 300), severity: "error", kind: "server_install_failed", link: `/servers/${serverId}/console`,
    });
  }
}

async function runInstall(
  serverId: number, installId: string, softwareName: string, mcVersion: string,
  javaMajor: number, directory: string, ownerServerId: number,
): Promise<void> {
  const publish = (label: string, progress: number, total: number, done = false, error?: string) => {
    bus.publish(serverTopic(serverId), {
      type: "progress", kind: "install", id: installId, label, progress, total, done, error,
    });
  };
  try {
    // Provider metadata decides the Java major: proxies are not Minecraft versions, so the
    // version table underestimates (Velocity 4.x needs Java 25, not 21) and the server dies
    // with UnsupportedClassVersionError right after install.
    let effectiveMajor = javaMajor;
    const required = await minimumJavaFor(
      queryOne<{ software: string }>("SELECT software FROM servers WHERE id = ?", [serverId])!.software as any,
      mcVersion,
    ).catch(() => null);
    if (required && required > effectiveMajor) {
      effectiveMajor = required;
      run("UPDATE servers SET java_major = ? WHERE id = ?", [required, serverId]);
      publish(`${softwareName} ${mcVersion} needs Java ${required} — installing that instead of Java ${javaMajor}`, 0, 0);
    }
    publish(`Installing Java ${effectiveMajor} runtime`, 0, 0);
    const runtime = await ensureRuntime(effectiveMajor);
    run("UPDATE servers SET java_runtime_id = ? WHERE id = ?", [runtime.id, serverId]);
    publish(`Installing ${softwareName} ${mcVersion}`, 0, 0);
    const result = await installServer({
      uuid: "", software: queryOne<{ software: string }>("SELECT software FROM servers WHERE id = ?", [serverId])!.software,
      mcVersion, memoryMb: 0, cpuPercent: 0, directory, javaMajor: effectiveMajor, serverId,
      onProgress: (stage, received, total) => publish(stage, received, total),
    });
    // software_version is what the UI shows next to the software name; the jar file name
    // ("server.jar", a forge launch script, …) is recorded in the activity metadata instead.
    const softwareVersion = result.build ? `${result.version}-${result.build}` : result.version;
    run(
      `UPDATE servers SET status = 'offline', installed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        software_version = ?, java_runtime_id = ?, install_log = NULL WHERE id = ?`,
      [softwareVersion, runtime.id, serverId],
    );
    publish(`${softwareName} ${mcVersion} installed`, 1, 1, true);
    recordActivity({
      type: "server.installed", serverId, target: mcVersion,
      metadata: { jar: result.jarFile, sha256: result.sha256, source: result.source },
    });
    notify({
      title: `Server installed: ${queryOne<{ name: string }>("SELECT name FROM servers WHERE id = ?", [serverId])?.name}`,
      body: `${softwareName} ${mcVersion} is ready to start.`,
      severity: "success", kind: "server_installed", link: `/servers/${serverId}/overview`,
    });

    /*
     * Recommended plugins (ViaVersion + ViaBackwards) for Paper/Purpur. Best effort by design:
     * the server is already installable, so a Modrinth hiccup must never fail the install — it is
     * reported in the console and the activity log instead.
     */
    try {
      const { installRecommendedPlugins, recommendsPlugins } = await import("../plugins/recommended");
      const serverSoftware = queryOne<{ software: ServerSoftwareId }>(
        "SELECT software FROM servers WHERE id = ?", [serverId],
      )?.software;
      if (serverSoftware && recommendsPlugins(serverSoftware)) {
        const pluginResult = await installRecommendedPlugins(serverId, { actor: "installer" });
        if (pluginResult.installed.length > 0) {
          const list = pluginResult.installed.map((entry) => `${entry.title} ${entry.version}`).join(", ");
          systemLine(serverId, `Recommended plugins installed: ${list}.`);
          recordActivity({
            type: "server.plugins_recommended", serverId, target: String(serverSoftware),
            metadata: { installed: pluginResult.installed.map((entry) => entry.file) },
          });
        }
        for (const failure of pluginResult.failed) {
          systemLine(serverId, `Recommended plugin ${failure.title} could not be installed: ${failure.message}`);
        }
      }
    } catch (error) {
      console.warn("[rslmc] recommended plugin install failed:", error);
      systemLine(serverId, `Recommended plugins were skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[rslmc] install failed for server #${serverId}: ${message}`);
    /*
     * Persist the reason: a server stuck in "error" must tell the operator *why* it failed.
     * But never overwrite the status of a server that is currently running — a failed background
     * reinstall used to turn a healthy running server into "error" on the Overview page.
     */
    if (isRunning(serverId)) {
      run("UPDATE servers SET install_log = ? WHERE id = ?", [message.slice(0, 2000), serverId]);
    } else {
      run("UPDATE servers SET status = 'error', install_log = ? WHERE id = ?", [message.slice(0, 2000), serverId]);
    }
    publish("Installation failed", 0, 0, true, message.slice(0, 2000));
    notify({
      title: `Installation failed on server #${serverId}`,
      body: message.slice(0, 300),
      severity: "error", kind: "install_failed", link: `/servers/${serverId}/console`,
    });
  }
}

function initialServerProperties(input: CreateServerInput): string {
  const isProxy = softwareDefinition(input.software as any).proxy;
  if (isProxy) {
    return [
      "# Generated by RSLMC",
      `# Proxy configuration for ${input.name}`,
      "bind=0.0.0.0:" + input.port,
      "motd=&b" + input.name,
      "show-max-players=" + 500,
      "online-mode=true",
      "force-key-authentication=true",
      "player-info-forwarding-mode=modern",
      "announce-forge=false",
      "",
    ].join("\n");
  }
  return [
    "#Minecraft server properties",
    "#Generated by RSLMC",
    `server-port=${input.port}`,
    "server-ip=",
    "motd=" + input.name.replace(/[\r\n]/g, " "),
    "max-players=20",
    "gamemode=survival",
    "difficulty=easy",
    "pvp=true",
    "online-mode=true",
    "white-list=false",
    "enforce-whitelist=false",
    "view-distance=10",
    "simulation-distance=10",
    "level-name=world",
    "enable-rcon=false",
    "enable-query=false",
    "spawn-protection=16",
    "",
  ].join("\n");
}

export async function deleteServer(serverId: number, actor: string, opts: { deleteFiles: boolean; deleteBackups: boolean }): Promise<void> {
  const row = queryOne<any>("SELECT * FROM servers WHERE id = ?", [serverId]);
  if (!row) throw new ApiException(404, "server_not_found", "Server not found");

  /*
   * A remote server is deleted on the node that runs it. If the node refuses (still running, for
   * instance) the local record must stay: a row without files behind it is exactly the "ghost server"
   * this panel used to leave behind.
   */
  const link = linkForServer(serverId);
  if (link) {
    const node = getNode(link.node_id);
    if (!node) throw new ApiException(409, "node_missing", "The node that hosts this server no longer exists.");
    await nodeRequestOrThrow(node, `/api/servers/${link.remote_server_id}`, {
      method: "DELETE",
      // The node's own delete route asks for the name as confirmation; the operator already typed it
      // on this panel, so it is passed along rather than making them type it twice.
      body: { confirmName: row.name, deleteFiles: opts.deleteFiles, deleteBackups: opts.deleteBackups },
      timeoutMs: 60_000,
    });
    run("DELETE FROM servers WHERE id = ?", [serverId]);
    releaseAllocations(serverId);
    dropLink(serverId);
    recordActivity({
      type: "server.deleted", serverId: null, target: row.name, actorName: actor, result: "info",
      metadata: { deleteFiles: opts.deleteFiles, deleteBackups: opts.deleteBackups, node: node.name },
    });
    return;
  }
  if (isRunning(serverId)) throw new ApiException(409, "server_running", "Stop the server before deleting it");

  /*
   * A container outlives the row unless it is removed here, and then the port stays bound and the name
   * stays taken — the next server with that uuid cannot start, and `docker ps` is full of ghosts. The
   * name is derived from the uuid, so it is known even after the row is gone.
   */
  if (row.runtime === "docker") {
    const removed = removeContainer(containerNameFor(row.uuid));
    if (!removed.ok) {
      recordActivity({
        type: "server.container_cleanup_failed", serverId: null, target: row.name, actorName: actor,
        result: "failure", metadata: { message: removed.message },
      });
    }
  }

  run("DELETE FROM servers WHERE id = ?", [serverId]);
  // Free the port: without this the allocation row kept the port reserved forever and the
  // next server on that port failed with a UNIQUE constraint error.
  releaseAllocations(serverId);
  if (opts.deleteFiles) rmSync(serverDir(row.uuid), { recursive: true, force: true });
  if (opts.deleteBackups) rmSync(join(PATHS.backups, row.uuid), { recursive: true, force: true });
  recordActivity({
    type: "server.deleted", serverId: null, target: row.name, actorName: actor, result: "info",
    metadata: { deleteFiles: opts.deleteFiles, deleteBackups: opts.deleteBackups },
  });
}

/**
 * Removes server rows whose creation never finished: older builds wrote the database row
 * before the allocation, so a failed create left a phantom "installing" server with no
 * directory behind it. Those rows looked like duplicates of a retry.
 */
export function pruneGhostServers(): number {
  // Not filtered on status: bootstrap() flips stale 'installing' rows to 'offline' during the
  // boot reconcile, so the only safe signal is "never finished installing and no files on disk".
  const rows = query<{ id: number; uuid: string; name: string; created_at: string }>(
    `SELECT id, uuid, name, created_at FROM servers WHERE installed_at IS NULL`,
  );
  let removed = 0;
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const row of rows) {
    if (existsSync(serverDir(row.uuid))) continue;
    const createdAt = Date.parse(row.created_at ?? "");
    if (Number.isFinite(createdAt) && createdAt > cutoff) continue; // still being created
    run("DELETE FROM servers WHERE id = ?", [row.id]);
    releaseAllocations(row.id);
    removed += 1;
  }
  if (removed > 0) console.log(`[rslmc] removed ${removed} unfinished server record(s) with no directory`);
  return removed;
}

/** Heap-sizing flags that would overrule the panel's own `-Xmx` (they come later on the command line). */
const HEAP_OVERRIDE_PATTERN =
  /-XX:(?:MaxHeapSize|InitialHeapSize|MaxRAMPercentage|InitialRAMPercentage|MinRAMPercentage|MaxRAM|SoftMaxHeapSize)\b/i;

/**
 * Switches a server between standalone and Docker without touching its files.
 *
 * The files are the same either way (a container bind-mounts the server directory), so the switch is a
 * column and nothing else — but only while nothing is running: changing the launch method under a live
 * process would leave the panel tracking a JVM it can no longer stop.
 */
export async function updateServerRuntime(
  serverId: number,
  input: { runtime: "standalone" | "docker"; dockerImage?: string | null },
  actor: string,
): Promise<ServerSummary> {
  const row = queryOne<any>("SELECT * FROM servers WHERE id = ?", [serverId]);
  if (!row) throw new ApiException(404, "server_not_found", "Server not found");
  if (isRunning(serverId)) {
    throw new ApiException(409, "server_running", "Stop the server before changing how it runs.");
  }
  if (input.runtime === "docker") {
    const docker = probeDocker();
    if (!docker.available) {
      throw new ApiException(409, "docker_unavailable",
        `Docker is not usable on this machine: ${docker.reason ?? "the daemon is not answering"}.`);
    }
  }
  const image = input.runtime === "docker"
    ? (input.dockerImage?.trim() || (isAppSoftware(row.software)
        ? appImageFor(row.software as AppFamily, row.mc_version, await yolksAllTags()).reference
        : imageForMajor(Number(row.java_major), new Set()).reference))
    : null;
  run(
    "UPDATE servers SET runtime = ?, docker_image = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
    [input.runtime, image, serverId],
  );
  recordActivity({
    type: "server.runtime_changed", serverId, target: row.name, actorName: actor,
    metadata: { runtime: input.runtime, image },
  });
  return getServer(serverId);
}

export function updateServerSettings(
  serverId: number, patch: Record<string, unknown>, actor: string,
): { server: ServerSummary; warnings: string[] } {
  const row = queryOne<any>("SELECT * FROM servers WHERE id = ?", [serverId]);
  if (!row) throw new ApiException(404, "server_not_found", "Server not found");
  const fields: string[] = [];
  const values: any[] = [];
  const allowed: Record<string, string> = {
    name: "name", description: "description", icon: "icon", memoryMb: "memory_mb", cpuPercent: "cpu_percent",
    diskMb: "disk_mb", jvmArgs: "jvm_args", serverArgs: "server_args", autoStart: "auto_start",
    crashRecovery: "crash_recovery", port: "port", bindIp: "bind_ip",
    publicHost: "public_host", publicPort: "public_port",
    // Python/Node only; validated below so it can never point outside the server directory.
    entryFile: "entry_file",
  };
  const warnings: string[] = [];
  /*
   * The entry file is only meaningful for interpreter-run software, and it is a path that ends up on a
   * command line — so it is validated here rather than trusted from the request.
   */
  if (patch.entryFile !== undefined) {
    if (!isAppSoftware(row.software)) {
      throw new ApiException(400, "not_an_app_server",
        "Entry files apply to Python and Node.js servers only; this server is started from a Minecraft jar.");
    }
    const problem = validateEntryFile(String(patch.entryFile ?? ""), row.software as AppFamily);
    if (problem) throw new ApiException(400, "invalid_entry_file", problem.message);
    patch = { ...patch, entryFile: normaliseEntryFile(String(patch.entryFile ?? ""), row.software as AppFamily) };
  }
  /*
   * -Xms/-Xmx are derived from the memory allocation and always placed ahead of these flags, so a
   * hand-written "-Xmx" here would build an invalid command line ("Initial heap size set to a
   * larger value than the maximum heap size"). Reject it with an explanatory error instead of
   * silently rewriting the user's edit.
   */
  if (typeof patch.jvmArgs === "string" && /-Xm[sx](\d|\s|=|$)/.test(patch.jvmArgs)) {
    throw new ApiException(
      400, "memory_flags_in_jvm_args",
      "Remove -Xms / -Xmx from the JVM flags: the heap size comes from the memory allocation (-Xms and -Xmx are added automatically).",
    );
  }
  /*
   * ...and the same rule for the HotSpot equivalents. The panel writes `-Xmx<allocation>` and then
   * appends these flags, so a later `-XX:MaxHeapSize=` (the long form of -Xmx) silently won — the
   * allocation in the UI said 2 GB while the JVM ran with whatever the flag asked for. `*RAMPercentage`
   * is refused as well because it replaces the fixed maximum outright.
   */
  if (typeof patch.jvmArgs === "string" && HEAP_OVERRIDE_PATTERN.test(patch.jvmArgs)) {
    throw new ApiException(
      400, "memory_flags_in_jvm_args",
      "Remove -XX:MaxHeapSize / -XX:InitialHeapSize / -XX:MaxRAMPercentage from the JVM flags: the heap size comes from the memory allocation. " +
      "Native caps such as -XX:MaxDirectMemorySize are fine — they only limit.",
    );
  }
  for (const [key, column] of Object.entries(allowed)) {
    if (!(key in patch)) continue;
    let value = patch[key];
    if (["autoStart", "crashRecovery"].includes(key)) value = value ? 1 : 0;
    if (key === "memoryMb" && (Number(value) < MIN_ALLOCATION_MB || Number(value) > MAX_ALLOCATION_MB)) {
      throw new ApiException(400, "invalid_memory", `Memory must be between ${MIN_ALLOCATION_MB} MB and ${MAX_ALLOCATION_MB / 1024} GB`);
    }
    if (key === "cpuPercent" && (Number(value) < 10 || Number(value) > 1600)) throw new ApiException(400, "invalid_cpu", "CPU allocation must be between 10% and 1600%");
    if (key === "port" && !isValidPort(Number(value))) throw new ApiException(400, "invalid_port", "Invalid port");
    if (key === "publicHost") {
      try { value = normalisePublicHost(value); } catch (err) {
        throw new ApiException(400, "invalid_public_address", err instanceof Error ? err.message : "Invalid public address");
      }
    }
    if (key === "publicPort") {
      try { value = validatePublicPort(value); } catch (err) {
        throw new ApiException(400, "invalid_public_port", err instanceof Error ? err.message : "Invalid public port");
      }
    }
    if (key === "name" && !/^[A-Za-z0-9 _.\-]{2,60}$/.test(String(value))) throw new ApiException(400, "invalid_name", "Invalid server name");
    fields.push(`${column} = ?`);
    values.push(value);
  }
  /*
   * Java runtime choice. A missing runtime must never dead-end unrelated settings (name, memory,
   * ports): the start path calls ensureRuntime() and downloads Eclipse Temurin on demand, so a
   * stale or wiped runtime is reset to "managed automatically" with an honest warning instead of
   * a 400 that leaves the form unsaveable.
   */
  if ("javaRuntimeId" in patch) {
    const requested = Number(patch.javaRuntimeId);
    if (!requested || requested <= 0) {
      fields.push("java_runtime_id = ?");
      values.push(null);
    } else {
      const runtime = runtimeInfo(requested);
      if (!runtime) {
        fields.push("java_runtime_id = ?");
        values.push(null);
        warnings.push(`The selected Java runtime (#${requested}) no longer exists — RSLMC fell back to the managed Java ${row.java_major} runtime, which is downloaded automatically when the server starts.`);
      } else if (runtime.nodeId != null && runtime.nodeId !== row.node_id) {
        throw new ApiException(400, "java_wrong_node", `That Java runtime belongs to another node and cannot be used here.`);
      } else if (!resolveExecutable(runtime)) {
        fields.push("java_runtime_id = ?");
        values.push(null);
        warnings.push(`Java ${runtime.major} (${runtime.version}) is registered but its files are missing at ${runtime.path} — RSLMC will download a fresh Java ${runtime.major} runtime when the server starts.`);
      } else {
        fields.push("java_runtime_id = ?");
        values.push(requested);
        // Keep the recorded requirement in step with the runtime the operator picked.
        fields.push("java_major = ?");
        values.push(runtime.major);
      }
    }
  }
  if (fields.length > 0) {
    run(`UPDATE servers SET ${fields.join(", ")}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, [...values, serverId]);
    invalidateServerCaches(serverId);
    recordActivity({
      type: "server.settings_changed", serverId, target: row.name, actorName: actor,
      metadata: { fields: Object.keys(patch) },
    });
  }
  return { server: getServer(serverId), warnings };
}

/**
 * Records the Minecraft EULA acceptance for an existing server and restores eula.txt.
 * Creation records it up front (the wizard requires the checkbox); this exists for servers
 * that were created before that flag was stored, or whose directory was wiped.
 */
export function acceptEula(serverId: number, actor: string): void {
  const row = queryOne<{ uuid: string; name: string }>("SELECT uuid, name FROM servers WHERE id = ?", [serverId]);
  if (!row) throw new ApiException(404, "server_not_found", "Server not found");
  run("UPDATE servers SET eula_accepted = 1 WHERE id = ?", [serverId]);
  const directory = serverDir(row.uuid);
  mkdirSync(directory, { recursive: true });
  writeFileAtomic(
    join(directory, "eula.txt"),
    "# Accepted through RSLMC — https://aka.ms/MinecraftEULA\neula=true\n",
  );
  recordActivity({
    type: "server.eula_accepted", serverId, target: row.name, actorName: actor,
    metadata: { eula: "https://aka.ms/MinecraftEULA" },
  });
}

export function reinstallServer(serverId: number, actor: string, preserveData: boolean): { installId: string } {
  const row = getServerRow(serverId);
  if (isRunning(serverId)) throw new ApiException(409, "server_running", "Stop the server before reinstalling");
  const directory = serverDir(row.uuid);
  if (!preserveData) {
    for (const entry of ["world", "world_nether", "world_the_end"]) rmSync(join(directory, entry), { recursive: true, force: true });
  }
  run("UPDATE servers SET status = 'installing', installed_at = NULL WHERE id = ?", [serverId]);
  const installId = randomUUID();
  /*
   * Reinstall means different things per software family: a Minecraft server re-downloads its jar, while
   * a Python/Node server re-verifies its interpreter and writes the starter files back. Sending the app
   * server down the Minecraft path failed with "Java 0 is not a selectable major version".
   */
  if (isAppSoftware(row.software)) {
    const family = row.software as AppFamily;
    const entry = normaliseEntryFile(row.entry_file ?? "", family);
    void runAppInstall(serverId, installId, family, row.mc_version, entry, directory);
  } else {
    void runInstall(serverId, installId, softwareDefinition(row.software as any).name, row.mc_version, row.java_major, directory, serverId);
  }
  recordActivity({ type: "server.reinstalled", serverId, target: row.name, actorName: actor, metadata: { preserveData } });
  return { installId };
}

export function serverMetricsHistory(serverId: number, rangeMs: number): { ts: number; cpu: number; mem: number; players: number }[] {
  const since = Date.now() - rangeMs;
  return query<any>(
    "SELECT ts, cpu_percent, mem_bytes, players FROM server_metrics WHERE server_id = ? AND ts >= ? ORDER BY ts",
    [serverId, since],
  ).map((row) => ({ ts: row.ts, cpu: row.cpu_percent, mem: row.mem_bytes, players: row.players }));
}

export function currentServerMetrics(serverId: number) {
  return currentMetrics(serverId);
}

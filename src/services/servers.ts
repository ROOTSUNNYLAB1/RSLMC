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
import type { ServerSummary, ServerStatus, UserPublic } from "../shared/types";

export interface ServerRowDb {
  [key: string]: any;
}

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
    autoStart: row.auto_start === 1,
    crashRecovery: row.crash_recovery === 1,
    createdAt: row.created_at,
    lastStartedAt: row.last_started_at,
    installedAt: row.installed_at,
    usage: (() => {
      if (!live || !state.pid) return null;
      const peek = peekProcess(state.pid);
      return { cpuPercent: peek.cpuPercent, memBytes: peek.rssBytes, cpuSource: peek.source };
    })(),
    uptimeSeconds: live ? uptimeSeconds(row.id) : 0,
    playersOnline: live ? playersOnline : (properties?.c ?? 0),
    maxPlayers: Number(
      readMaxPlayers(row) ?? 20,
    ),
    enforcement,
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
  /** Where a server goes when it is taken away from this account (servers always need an owner). */
  reassignOwnerTo?: number | null;
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
      if (currentShared.has(id)) continue;
      run("INSERT OR IGNORE INTO server_subusers (server_id, user_id) VALUES (?, ?)", [id, userId]);
      sharedAdded.push(id);
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
  if (!existing) {
    insert("INSERT INTO allocations (node_id, ip, port, server_id, notes) VALUES (?, ?, ?, ?, ?)", [
      nodeId, ip, port, serverId, note,
    ]);
    return;
  }
  if (existing.server_id == null) {
    run("UPDATE allocations SET server_id = ?, notes = ? WHERE id = ?", [serverId, note, existing.id]);
    return;
  }
  const owner = queryOne<{ id: number; name: string }>("SELECT id, name FROM servers WHERE id = ?", [existing.server_id]);
  if (!owner) {
    // Orphaned allocation from a server that no longer exists — reclaim it.
    run("UPDATE allocations SET server_id = ?, notes = ? WHERE id = ?", [serverId, note, existing.id]);
    return;
  }
  throw new ApiException(
    409, "allocation_conflict",
    `Port ${port} on ${ip} is already allocated to the server "${owner.name}" (#${owner.id}). Pick another port.`,
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
  if (!input.acceptEula) throw new ApiException(400, "eula_required", "You must accept the Minecraft EULA to create a server");
  const definition = softwareDefinition(input.software as any);
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
  if (!(await isTcpPortFree(bindIp, input.port))) {
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

  const node = queryOne<{ id: number }>("SELECT id FROM nodes WHERE id = ?", [input.nodeId]);
  if (!node) throw new ApiException(400, "invalid_node", "Node not found");
  const owner = queryOne<{ id: number }>("SELECT id FROM users WHERE id = ?", [input.ownerId]);
  if (!owner) throw new ApiException(400, "invalid_owner", "Owner not found");

  const javaMajor = input.javaMajor ?? javaMajorForMcVersion(input.mcVersion);
  // Optimised defaults instead of an empty flag list: Aikar's G1GC set for game servers, the small
  // proxy set for Velocity/BungeeCord, SerialGC on tiny heaps. A user-supplied string always wins.
  if (input.jvmArgs && /-Xm[sx](\d|\s|=|$)/.test(input.jvmArgs)) {
    throw new ApiException(400, "memory_flags_in_jvm_args",
      "Remove -Xms / -Xmx from the JVM flags: the heap size comes from the memory allocation.");
  }
  const jvmArgs = input.jvmArgs?.trim() ? input.jvmArgs.trim() : defaultJvmArgsFor(input.software as ServerSoftwareId, input.memoryMb);
  const uuid = randomUUID();
  const enforcement = describeEnforcement();

  // The server row and its allocation are written together: a failure here must not leave a
  // half-created server behind (that is what produced "duplicate" servers in earlier builds).
  const serverId = transaction(() => {
    const id = insert(
      `INSERT INTO servers (uuid, name, description, icon, owner_id, node_id, software, software_version, mc_version,
        java_major, status, memory_mb, cpu_percent, disk_mb, bind_ip, port, public_host, public_port,
        jvm_args, server_args, auto_start, crash_recovery, enforcement, eula_accepted)
       VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, 'installing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        uuid, input.name, input.description ?? null, input.icon ?? null, input.ownerId, input.nodeId,
        input.software, input.mcVersion, javaMajor, input.memoryMb, input.cpuPercent, input.diskMb,
        bindIp, input.port, publicHost, publicPort, jvmArgs, input.serverArgs ?? "nogui",
        input.autoStart ? 1 : 0, input.crashRecovery ? 1 : 0, JSON.stringify(enforcement),
      ],
    );
    reserveAllocation(input.nodeId, bindIp, input.port, id, `Primary allocation for ${input.name}`);
    return id;
  });

  const directory = serverDir(uuid);
  try {
    mkdirSync(directory, { recursive: true });
    writeFileAtomic(join(directory, "server.properties"), initialServerProperties(input));
    writeFileAtomic(join(directory, "ops.json"), "[]\n");
    writeFileAtomic(join(directory, "whitelist.json"), "[]\n");
    writeFileAtomic(join(directory, "banned-players.json"), "[]\n");
    writeFileAtomic(join(directory, "banned-ips.json"), "[]\n");
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
    void runInstall(serverId, installId, definition.name, input.mcVersion, javaMajor, directory, serverId);
  }
  return { server, installId };
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

export function deleteServer(serverId: number, actor: string, opts: { deleteFiles: boolean; deleteBackups: boolean }): void {
  const row = queryOne<any>("SELECT * FROM servers WHERE id = ?", [serverId]);
  if (!row) throw new ApiException(404, "server_not_found", "Server not found");
  if (isRunning(serverId)) throw new ApiException(409, "server_running", "Stop the server before deleting it");
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
  };
  const warnings: string[] = [];
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
  void runInstall(serverId, installId, softwareDefinition(row.software as any).name, row.mc_version, row.java_major, directory, serverId);
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

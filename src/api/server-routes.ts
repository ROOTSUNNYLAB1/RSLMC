import { Router, json, validate, v, badRequest, notFound, pagination, ApiException } from "../shared/http";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, extname, sep, resolve } from "node:path";
import { requireServerAccess, requirePermission } from "../auth";
import {
  listServersForUser, getServer, createServer, deleteServer, updateServerSettings, reinstallServer,
  serverMetricsHistory, currentServerMetrics, acceptEula,
} from "../services/servers";
import {
  startServer, stopServer, restartServer, killServer, sendCommand, consoleHistory, runtimeState, isRunning,
} from "../processes/manager";
import { readProperties, writeProperties, PROPERTY_SPECS } from "../minecraft/properties";
import { applyPlayerAction, listPlayers, playerSessions, resolvePlayerRef, syncPlayerFiles, whitelistEnabled, setWhitelistEnabled } from "../minecraft/players";
import { readPlayerData, applyPlayerDataOp } from "../minecraft/player-data";
import { listWorlds, createEmptyWorld, deleteWorld, renameWorld, rediscoverWorlds, detectWorlds } from "../minecraft/worlds";
import { CHUNKBASE_DIMENSIONS, CHUNKBASE_PLATFORMS, chunkbasePlatformFor, platformIsExact, seedMapUrl } from "../minecraft/chunkbase";
import { SOFTWARE_CATALOG, listVersions, resolveBuild } from "../minecraft/providers";
import { LOADER_MAP, listInstalled, installVersion, removePlugin, searchProjects, getProject, getVersions, checkUpdates } from "../plugins/modrinth";
import { installRecommendedPlugins, recommendsPlugins, RECOMMENDED_PLUGINS } from "../plugins/recommended";
import { JVM_PRESETS, detectJvmPreset, heapMbFor, initialHeapMbFor, defaultJvmArgsFor, isProxySoftware } from "../minecraft/jvm-presets";
import { MIN_ALLOCATION_MB, MAX_ALLOCATION_MB } from "../shared/memory";
import { listBackups, createBackup, deleteBackup, restoreBackup, verifyBackup, backupFilePath } from "../services/backups";
import { listSchedules, createSchedule, updateSchedule, deleteSchedule, executeSchedule, runHistory } from "../services/schedules";
import { validateCron } from "../services/cron";
import { listActivity } from "../services/audit";
import { query, queryOne, run, insert } from "../database";
import { serverDir } from "../shared/config";
import { javaMajorForMcVersion, javaCompatible } from "../minecraft/java-requirements";
import { listRuntimes, ensureRuntime, removeRuntime, findRuntimeForMajor, resolveExecutable, runtimeInfo } from "../java/manager";
import { describeEnforcement } from "../resources/enforcement";
import { detectCgroups, installHelper } from "../resources/cgroups";
import type { RequestContext } from "../shared/http";
import type { ServerSoftwareId } from "../shared/types";
import { hostStats } from "../resources/host";

function requireServer(ctx: RequestContext, permission?: Parameters<typeof requireServerAccess>[2]) {
  const id = Number(ctx.params.id);
  if (!Number.isFinite(id)) throw badRequest("Invalid server id");
  requireServerAccess(ctx.user, id, permission);
  return id;
}

export function registerServerRoutes(api: Router): void {
  /* ---------------- Catalogue ---------------- */

  api.get("/api/software", async () => json({ data: SOFTWARE_CATALOG }));

  /*
   * Minimal host facts for the create wizard (CPU default, memory suggestion). Authenticated like
   * every other route; deliberately small — the full host report lives in /api/system.
   */
  api.get("/api/system/host", async () => {
    const host = hostStats();
    return json({
      cpuCores: host.cpuCores,
      memoryTotalBytes: host.memoryTotalBytes,
      memoryUsedBytes: host.memoryUsedBytes,
      loadAverage: host.loadAverage,
      platform: host.os,
    });
  });

  api.get("/api/software/:id/versions", async (ctx) => {
    const includeExperimental = ctx.query("experimental") === "true";
    const versions = await listVersions(ctx.params.id as any, includeExperimental);
    return json({ data: versions, experimental: includeExperimental });
  });

  api.get("/api/software/:id/build/:version", async (ctx) => {
    const build = await resolveBuild(ctx.params.id as any, ctx.params.version);
    // The download URL is intentionally exposed: it is the vendor's public artifact.
    return json({ build: { ...build, url: build.url }, javaMajor: build.javaMinimum ?? javaMajorForMcVersion(ctx.params.version) });
  });

  /* ---------------- Servers ---------------- */

  api.get("/api/servers", async (ctx) => {
    if (!ctx.user) throw notFound();
    requirePermission(ctx.user, "server.view");
    const servers = listServersForUser(ctx.user);
    return json({ data: servers });
  });

  api.post("/api/servers", async (ctx) => {
    requirePermission(ctx.user, "server.create");
    const body = await ctx.body();
    const input = validate(
      {
        name: v.string({ min: 2, max: 60 }),
        description: v.string({ max: 500, optional: true }),
        ownerId: v.number({ integer: true, min: 1 }),
        nodeId: v.number({ integer: true, min: 1 }),
        software: v.oneOf(SOFTWARE_CATALOG.map((item) => item.id)),
        mcVersion: v.string({ min: 1, max: 40 }),
        memoryMb: v.number({ integer: true, min: MIN_ALLOCATION_MB, max: MAX_ALLOCATION_MB }),
        cpuPercent: v.number({ integer: true, min: 10, max: 1600 }),
        diskMb: v.number({ integer: true, min: 512, max: 1048576 }),
        bindIp: v.string({ min: 3, max: 45, optional: true }),
        port: v.number({ integer: true, min: 1, max: 65535 }),
        // Tunnel / port-forwarding address for players (playit.gg, ngrok, …) — both optional.
        publicHost: v.string({ max: 253, optional: true }),
        publicPort: v.number({ integer: true, min: 1, max: 65535, optional: true }),
        javaMajor: v.number({ integer: true, min: 8, max: 25, optional: true }),
        jvmArgs: v.string({ max: 2000, optional: true }),
        serverArgs: v.string({ max: 500, optional: true }),
        autoStart: v.boolean({ optional: true }),
        crashRecovery: v.boolean({ optional: true }),
        acceptEula: v.boolean(),
      },
      body,
    );
    const result = await createServer(
      {
        name: input.name!,
        description: input.description ?? undefined,
        ownerId: input.ownerId!,
        nodeId: input.nodeId!,
        software: input.software!,
        mcVersion: input.mcVersion!,
        memoryMb: input.memoryMb!,
        cpuPercent: input.cpuPercent!,
        diskMb: input.diskMb!,
        bindIp: input.bindIp ?? "0.0.0.0",
        port: input.port!,
        publicHost: input.publicHost ?? null,
        publicPort: input.publicPort ?? null,
        javaMajor: input.javaMajor ?? undefined,
        jvmArgs: input.jvmArgs ?? "",
        serverArgs: input.serverArgs ?? "nogui",
        autoStart: input.autoStart ?? false,
        crashRecovery: input.crashRecovery ?? false,
        acceptEula: input.acceptEula!,
      },
      ctx.user!.username,
    );
    return json(result, { status: 201 });
  });

  api.get("/api/servers/:id", async (ctx) => {
    const id = requireServer(ctx);
    syncPlayerFiles(id);
    const server = getServer(id);
    const state = runtimeState(id);
    const java = server.javaRuntimeId
      ? listRuntimes().find((runtime) => runtime.id === server.javaRuntimeId) ?? null
      : null;
    return json({
      server,
      runtime: {
        status: state.status,
        pid: state.pid,
        exitCode: state.exitCode,
        lastError: state.lastError,
        ready: state.ready,
        stopKind: state.stopKind,
        enforcementMessage: state.enforcementMessage,
        cgroupAttached: state.cgroupAttached,
        foreign: state.foreign,
        uptimeSeconds: server.uptimeSeconds,
      },
      java,
      // Why the last installation failed (null when it never failed) — surfaced in the UI.
      installError: (() => {
        if (server.status !== "error") return null;
        const row = queryOne<{ install_log: string | null }>("SELECT install_log FROM servers WHERE id = ?", [id]);
        return row?.install_log?.trim() ? row.install_log.trim() : null;
      })(),
      javaCompatibility: javaCompatible(server.mcVersion, server.javaMajor),
      jvm: (() => {
        const row = queryOne<{ jvm_args: string | null; memory_mb: number }>(
          "SELECT jvm_args, memory_mb FROM servers WHERE id = ?", [id],
        );
        const allocation = Number(row?.memory_mb ?? 0);
        return {
          args: row?.jvm_args ?? "",
          preset: detectJvmPreset(row?.jvm_args ?? ""),
          allocationMb: allocation,
          heapMb: heapMbFor(allocation),
          initialHeapMb: initialHeapMbFor(allocation),
          // Allocation is the kernel cap for the whole process; the JVM keeps this much for itself.
          overheadMb: Math.max(0, allocation - heapMbFor(allocation)),
        };
      })(),
      metrics: currentServerMetrics(id),
      enforcement: describeEnforcement(),
    });
  });

  /**
   * Records the Minecraft EULA acceptance for an existing server and writes eula.txt, so a
   * server whose install predates the acceptance flag can be started without being recreated.
   */
  api.post("/api/servers/:id/eula", async (ctx) => {
    const id = requireServer(ctx, "server.start");
    const body = await ctx.body<{ accept?: boolean }>();
    if (body.accept !== true) throw badRequest("accept must be true to record the EULA acceptance");
    acceptEula(id, ctx.user!.username);
    return json({ ok: true });
  });

  api.patch("/api/servers/:id", async (ctx) => {
    const id = requireServer(ctx, "server.settings");
    const body = await ctx.body();
    const result = updateServerSettings(id, body, ctx.user!.username);
    return json(result);
  });

  api.delete("/api/servers/:id", async (ctx) => {
    const id = requireServer(ctx, "server.delete");
    const body = await ctx.body<{ confirmName?: string; deleteFiles?: boolean; deleteBackups?: boolean }>();
    const server = getServer(id);
    if (body.confirmName !== server.name) throw badRequest(`Type "${server.name}" to confirm deletion`);
    deleteServer(id, ctx.user!.username, {
      deleteFiles: body.deleteFiles === true,
      deleteBackups: body.deleteBackups === true,
    });
    return json({ ok: true });
  });

  api.post("/api/servers/:id/power", async (ctx) => {
    const body = await ctx.body<{ action?: string }>();
    const action = String(body.action ?? "");
    const permission = action === "kill" ? "server.kill" : action === "start" ? "server.start" : action === "stop" ? "server.stop" : "server.restart";
    const id = requireServer(ctx, permission);
    const actor = ctx.user!.username;
    switch (action) {
      case "start": await startServer(id, actor); break;
      case "stop": await stopServer(id, actor); break;
      case "restart": await restartServer(id, actor); break;
      case "kill": await killServer(id, actor); break;
      default: throw badRequest("Action must be start, stop, restart or kill");
    }
    return json({ ok: true, status: runtimeState(id).status });
  });

  /* ---------------- Console ---------------- */

  api.get("/api/servers/:id/console", async (ctx) => {
    const id = requireServer(ctx);
    const lines = consoleHistory(id);
    const limit = Math.min(5000, Number(ctx.query("limit") ?? 500));
    // An adopted process is running but has no stdout pipe, so `live` is true and `captured` false:
    // the UI must not claim the console is offline, and must not pretend it is following the log.
    const captured = isRunning(id);
    const foreign = runtimeState(id).foreign;
    return json({ data: lines.slice(-limit), live: captured || foreign, captured, foreign });
  });

  api.post("/api/servers/:id/console", async (ctx) => {
    const id = requireServer(ctx, "server.command");
    const body = await ctx.body<{ command?: string }>();
    const command = String(body.command ?? "").trim();
    if (!command) throw badRequest("Command is empty");
    if (!isRunning(id)) throw badRequest("The server is not running");
    sendCommand(id, command, ctx.user!.username);
    return json({ ok: true });
  });

  api.get("/api/servers/:id/metrics", async (ctx) => {
    const id = requireServer(ctx);
    const range = ctx.query("range") ?? "1h";
    const ranges: Record<string, number> = {
      "15m": 15 * 60_000, "1h": 60 * 60_000, "6h": 6 * 60 * 60_000,
      "24h": 24 * 60 * 60_000, "7d": 7 * 24 * 60 * 60_000,
    };
    const history = serverMetricsHistory(id, ranges[range] ?? ranges["1h"]!);
    return json({ data: history, current: currentServerMetrics(id), range });
  });

  /* ---------------- Properties ---------------- */

  api.get("/api/servers/:id/properties", async (ctx) => {
    const id = requireServer(ctx);
    const server = getServer(id);
    const server_ = queryOne<{ uuid: string; mc_version: string }>("SELECT uuid, mc_version FROM servers WHERE id = ?", [id])!;
    const file = readProperties(serverDir(server_.uuid));
    return json({
      values: file.values,
      specs: PROPERTY_SPECS,
      exists: file.exists,
      mcVersion: server_.mc_version,
    });
  });

  api.put("/api/servers/:id/properties", async (ctx) => {
    /*
     * Typed property edits need `server.files`, not `server.settings`: an account that may already
     * edit server.properties through the file manager must not be blocked here, and the keys that
     * actually matter (port, bind address, rcon password) are refused below via `reserved` anyway.
     */
    const id = requireServer(ctx, ["server.settings", "server.files"]);
    const body = await ctx.body<{ values?: Record<string, string>; expectedModifiedAt?: number }>();
    if (!body.values || typeof body.values !== "object") throw badRequest("values object is required");
    const server = queryOne<{ uuid: string; port: number; name: string; memory_mb: number }>(
      "SELECT uuid, port, name, memory_mb FROM servers WHERE id = ?", [id],
    )!;
    // RSLMC owns the listening port and memory allocation; those are changed in Networking/Resources.
    const reserved = new Set(["server-port", "server-ip", "rcon.password"]);
    try {
      const result = writeProperties(serverDir(server.uuid), body.values, reserved);
      if (result.changed.length > 0) {
        run("UPDATE servers SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", [id]);
      }
      const { recordActivity } = await import("../services/audit");
      recordActivity({
        type: "properties.changed", serverId: id, target: server.name, actorName: ctx.user!.username,
        metadata: { changed: result.changed },
      });
      return json({
        ok: true,
        changed: result.changed,
        restartRequired: result.restartRequired,
        message: result.changed.length === 0
          ? "No changes were applied."
          : `${result.changed.length} propert${result.changed.length === 1 ? "y" : "ies"} saved${result.restartRequired ? ". A restart is required for these changes to take effect." : "."}`,
        reserved: [...reserved],
      });
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : "Could not save properties");
    }
  });

  /* ---------------- Players ---------------- */

  api.get("/api/servers/:id/players", async (ctx) => {
    const id = requireServer(ctx);
    const filter = (ctx.query("filter") ?? "all") as "all" | "operators" | "whitelist" | "banned";
    const players = listPlayers(id, filter);
    const state = runtimeState(id);
    const online = [...state.players.values()].map((player) => ({
      name: player.name,
      uuid: player.uuid,
      joinedAt: player.joinedAt,
      sessionSeconds: Math.floor((Date.now() - player.joinedAt) / 1000),
      operator: Boolean(queryOne("SELECT 1 AS ok FROM operators WHERE server_id = ? AND lower(name) = lower(?)", [id, player.name])),
      whitelisted: Boolean(queryOne("SELECT 1 AS ok FROM whitelist WHERE server_id = ? AND lower(name) = lower(?)", [id, player.name])),
    }));
    return json({
      data: players,
      online,
      counts: {
        online: online.length,
        operators: players.filter((p) => p.operator).length,
        whitelist: players.filter((p) => p.whitelisted).length,
        banned: players.filter((p) => p.banned).length,
        known: players.length,
      },
      whitelistEnabled: whitelistEnabled(id),
      live: isRunning(id),
    });
  });

  api.post("/api/servers/:id/players/action", async (ctx) => {
    const id = requireServer(ctx, "server.players");
    const body = await ctx.body<{ type?: string; username?: string; reason?: string; level?: number }>();
    const type = String(body.type ?? "");
    const username = String(body.username ?? "");
    const allowed = ["op", "deop", "whitelist.add", "whitelist.remove", "ban", "pardon", "kick"];
    if (!allowed.includes(type)) throw badRequest(`type must be one of ${allowed.join(", ")}`);
    if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) throw badRequest("Invalid Minecraft username");
    const result = await applyPlayerAction(
      id,
      { type: type as any, username, reason: body.reason, level: body.level } as any,
      ctx.user!.username,
    );
    return json(result);
  });

  api.post("/api/servers/:id/players/whitelist", async (ctx) => {
    const id = requireServer(ctx, "server.players");
    const body = await ctx.body<{ enabled?: boolean }>();
    setWhitelistEnabled(id, Boolean(body.enabled), ctx.user!.username);
    return json({ ok: true, whitelistEnabled: whitelistEnabled(id) });
  });

  /**
   * Full player inspector: real data read from `world/playerdata/<uuid>.dat`.
   * Nothing here is synthesised — if the file is missing the response says so.
   */
  api.get("/api/servers/:id/players/:uuid/data", async (ctx) => {
    const id = requireServer(ctx, "server.players");
    const player = resolvePlayerRef(id, String(ctx.params.uuid ?? "") || String(ctx.query("username") ?? ""));
    if (!player) {
      throw new ApiException(
        404, "no_player_data",
        "RSLMC has no UUID for this player yet. It is recorded the next time they join the server.",
      );
    }
    return json(readPlayerData(id, player.uuid));
  });

  api.post("/api/servers/:id/players/:uuid/data", async (ctx) => {
    const id = requireServer(ctx, "server.players");
    const player = resolvePlayerRef(id, String(ctx.params.uuid ?? "") || String(ctx.query("username") ?? ""));
    if (!player) {
      throw new ApiException(
        404, "no_player_data",
        "RSLMC has no UUID for this player yet. It is recorded the next time they join the server.",
      );
    }
    const uuid = player.uuid;
    const body = await ctx.body<{ op?: string }>();
    if (!body.op) throw badRequest("An operation is required");
    const snapshot = applyPlayerDataOp(id, uuid, body as never, ctx.user!.username);
    return json(snapshot);
  });

  api.get("/api/servers/:id/players/:uuid/sessions", async (ctx) => {
    const id = requireServer(ctx);
    return json({ data: playerSessions(id, ctx.params.uuid) });
  });

  /* ---------------- Worlds ---------------- */

  api.get("/api/servers/:id/worlds", async (ctx) => {
    const id = requireServer(ctx);
    rediscoverWorlds(id);
    return json({ data: listWorlds(id) });
  });

  api.post("/api/servers/:id/worlds", async (ctx) => {
    const id = requireServer(ctx, "server.worlds");
    const body = await ctx.body<{ folder?: string; seed?: string }>();
    const folder = String(body.folder ?? "").trim();
    if (!folder) throw badRequest("World folder name is required");
    const world = createEmptyWorld(id, folder, body.seed?.trim() || null);
    const { recordActivity } = await import("../services/audit");
    recordActivity({ type: "world.created", serverId: id, target: folder, actorName: ctx.user!.username });
    return json({ world }, { status: 201 });
  });

  api.delete("/api/servers/:id/worlds/:worldId", async (ctx) => {
    const id = requireServer(ctx, "server.worlds");
    const body = await ctx.body<{ confirmName?: string; backupFirst?: boolean }>();
    deleteWorld(id, Number(ctx.params.worldId), {
      confirmName: String(body.confirmName ?? ""),
      backupFirst: body.backupFirst !== false,
    });
    const { recordActivity } = await import("../services/audit");
    recordActivity({ type: "world.deleted", serverId: id, target: ctx.params.worldId, actorName: ctx.user!.username, result: "info" });
    return json({ ok: true });
  });

  api.patch("/api/servers/:id/worlds/:worldId", async (ctx) => {
    const id = requireServer(ctx, "server.worlds");
    const body = await ctx.body<{ folder?: string }>();
    renameWorld(id, Number(ctx.params.worldId), String(body.folder ?? ""));
    return json({ ok: true });
  });

  /* ---------------- Backups ---------------- */

  api.get("/api/servers/:id/backups", async (ctx) => {
    const id = requireServer(ctx);
    return json({ data: listBackups(id) });
  });

  api.post("/api/servers/:id/backups", async (ctx) => {
    const id = requireServer(ctx, "server.backups");
    const body = await ctx.body<{ name?: string; description?: string; kind?: string }>();
    const name = String(body.name ?? "").trim() || `backup-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`;
    const backup = await createBackup(id, {
      name,
      description: body.description,
      kind: (body.kind as any) ?? "full",
      actor: ctx.user!.username,
    });
    return json({ backup }, { status: 201 });
  });

  api.delete("/api/servers/:id/backups/:backupId", async (ctx) => {
    const id = requireServer(ctx, "server.backups");
    deleteBackup(id, Number(ctx.params.backupId), ctx.user!.username);
    return json({ ok: true });
  });

  api.post("/api/servers/:id/backups/:backupId/restore", async (ctx) => {
    const id = requireServer(ctx, "server.backups");
    const result = await restoreBackup(id, Number(ctx.params.backupId), ctx.user!.username);
    return json(result);
  });

  api.get("/api/servers/:id/backups/:backupId/verify", async (ctx) => {
    const id = requireServer(ctx, "server.backups");
    return json(await verifyBackup(id, Number(ctx.params.backupId)));
  });

  // Streams the archive as-is (no buffering) so multi-gigabyte backups do not sit in memory.
  api.get("/api/servers/:id/backups/:backupId/download", async (ctx) => {
    const id = requireServer(ctx, "server.backups");
    const backupId = Number(ctx.params.backupId);
    if (!Number.isInteger(backupId) || backupId <= 0) throw badRequest("backupId must be a positive integer");
    const entry = listBackups(id).find((backup) => backup.id === backupId);
    if (!entry) throw notFound("Backup not found");
    if (entry.status !== "completed") {
      throw new ApiException(409, "backup_incomplete", `This backup is ${entry.status}; only completed backups can be downloaded`);
    }
    const archive = backupFilePath(id, backupId);
    const file = Bun.file(archive.path);
    const fileName = archive.fileName.replace(/[^\w.\-]+/g, "_");
    return new Response(file.stream(), {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(file.size),
        "content-disposition": `attachment; filename="${fileName}"`,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
    });
  });

  /* ---------------- Schedules ---------------- */

  api.get("/api/servers/:id/schedules", async (ctx) => {
    const id = requireServer(ctx);
    return json({ data: listSchedules(id) });
  });

  api.post("/api/servers/:id/schedules", async (ctx) => {
    const id = requireServer(ctx, "server.schedules");
    const body = await ctx.body();
    const input = validate(
      {
        name: v.string({ min: 1, max: 120 }),
        cron: v.string({ min: 5, max: 120 }),
        action: v.oneOf(["restart", "start", "stop", "command", "backup", "announce", "cleanup"] as const),
        payload: v.string({ optional: true, max: 2000 }),
        enabled: v.boolean({ optional: true }),
        timezone: v.string({ max: 64, optional: true }),
      },
      { ...body, payload: body.payload ? JSON.stringify(body.payload) : undefined },
    );
    const schedule = createSchedule(id, {
      name: input.name!, cron: input.cron!, action: input.action!,
      payload: input.payload ? JSON.parse(input.payload) : {},
      enabled: input.enabled, timezone: input.timezone,
    });
    return json({ schedule }, { status: 201 });
  });

  api.patch("/api/servers/:id/schedules/:scheduleId", async (ctx) => {
    const id = requireServer(ctx, "server.schedules");
    const body = await ctx.body();
    const schedule = updateSchedule(id, Number(ctx.params.scheduleId), body);
    return json({ schedule });
  });

  api.delete("/api/servers/:id/schedules/:scheduleId", async (ctx) => {
    const id = requireServer(ctx, "server.schedules");
    deleteSchedule(id, Number(ctx.params.scheduleId));
    return json({ ok: true });
  });

  api.post("/api/servers/:id/schedules/:scheduleId/run", async (ctx) => {
    const id = requireServer(ctx, "server.schedules");
    // Scoped to this server: an id belonging to another server is a 404, never a remote control.
    const result = await executeSchedule(Number(ctx.params.scheduleId), "manual", { serverId: id });
    if (!result.ok && /not found/i.test(result.output)) throw notFound("Schedule not found");
    return json(result);
  });

  api.get("/api/servers/:id/schedules/:scheduleId/runs", async (ctx) => {
    const id = requireServer(ctx);
    return json({ data: runHistory(id, Number(ctx.params.scheduleId)) });
  });

  api.post("/api/cron/validate", async (ctx) => {
    const body = await ctx.body<{ expression?: string }>();
    return json(validateCron(String(body.expression ?? "")));
  });

  /* ---------------- Activity ---------------- */

  api.get("/api/servers/:id/activity", async (ctx) => {
    const id = requireServer(ctx);
    const { page, perPage, offset } = pagination(ctx.url, 30);
    const result = listActivity({
      serverId: id,
      types: ctx.query("types")?.split(",").filter(Boolean),
      search: ctx.query("search") ?? undefined,
      limit: perPage,
      offset,
    });
    return json({ ...result, page, perPage, totalPages: Math.ceil(result.total / perPage) });
  });

  /* ---------------- Settings / networking ---------------- */

  api.get("/api/servers/:id/settings", async (ctx) => {
    /*
     * Startup/JVM/runtime configuration is infrastructure: reading it needs the same permission as
     * changing it, otherwise a plain account can enumerate ports, flags and runtime pinning. The
     * Networking page reads the same payload for the public address, so allocation managers may too.
     */
    const id = requireServer(ctx, ["server.settings", "server.allocations"]);
    const row = queryOne<any>("SELECT * FROM servers WHERE id = ?", [id])!;
    const allocations = query<any>(
      "SELECT a.id, a.ip, a.port, a.ip_alias, a.notes, (a.port = ? AND a.ip = ?) AS is_primary FROM allocations a WHERE a.server_id = ?",
      [row.port, row.bind_ip, id],
    );
    return json({
      server: getServer(id),
      raw: {
        jvmArgs: row.jvm_args,
        serverArgs: row.server_args,
        startupCommand: row.startup_command,
        queryPort: row.query_port,
        rconPort: row.rcon_port,
        rconPasswordSet: Boolean(row.rcon_password),
        javaMajor: row.java_major,
        publicHost: row.public_host ?? null,
        publicPort: row.public_port ?? null,
        internalAddress: `${row.bind_ip}:${row.port}`,
      },
      allocations,
      jvmPresets: JVM_PRESETS,
      jvmPreset: detectJvmPreset(row.jvm_args),
      runtimes: listRuntimes(row.node_id),
      // What the server will actually run on, so the form can be honest about missing runtimes.
      java: (() => {
        const managed = findRuntimeForMajor(row.java_major, row.node_id);
        const pinned = row.java_runtime_id ? runtimeInfo(row.java_runtime_id) : null;
        return {
          requiredMajor: row.java_major,
          runtimeId: row.java_runtime_id ?? null,
          pinnedUsable: pinned ? Boolean(resolveExecutable(pinned)) : false,
          managedInstalled: Boolean(managed && resolveExecutable(managed)),
          managedVersion: managed?.version ?? null,
        };
      })(),
    });
  });

  /*
   * Limited startup control for accounts without `server.settings`.
   *
   * A JVM preset only changes tuning flags; the heap still comes from the allocation and the
   * process is still capped by cgroup/hard -Xmx, so this cannot turn a 1 GB server into a 16 GB one.
   * The curated list deliberately excludes `custom`, which is how a raw flag string (and with it
   * -Xmx, -Xss, -XX:MaxDirectMemorySize …) would reach the command line.
   */
  api.get("/api/servers/:id/startup-options", async (ctx) => {
    const id = requireServer(ctx, ["server.startup", "server.settings"]);
    const row = queryOne<{ software: string; mc_version: string; jvm_args: string | null; memory_mb: number; java_major: number }>(
      "SELECT software, mc_version, jvm_args, memory_mb, java_major FROM servers WHERE id = ?", [id],
    )!;
    const allocation = Number(row.memory_mb);
    const current = detectJvmPreset(row.jvm_args ?? "");
    const proxy = isProxySoftware(row.software as any);
    const alreadyCustom = current === "custom";
    return json({
      editable: true,
      software: row.software,
      mcVersion: row.mc_version,
      allocationMb: allocation,
      heapMb: heapMbFor(allocation),
      initialHeapMb: initialHeapMbFor(allocation),
      javaMajor: row.java_major,
      current,
      currentArgs: row.jvm_args ?? "",
      // `custom` is offered only so a server that already has hand-written flags keeps them visible;
      // it is never selectable here.
      presets: JVM_PRESETS.map((preset) => ({
        id: preset.id,
        label: preset.label,
        summary: preset.summary,
        recommended: Boolean(preset.recommended) || (proxy ? preset.id === "proxy" : preset.id === "aikar"),
        selectable: preset.id !== "custom",
        flags: preset.id === "custom" ? "" : preset.flags,
      })),
      note: alreadyCustom
        ? "This server uses hand-written JVM flags that were set with full server settings access. Picking a preset below replaces them."
        : "Changing the preset takes effect on the next restart.",
    });
  });

  api.put("/api/servers/:id/startup-options", async (ctx) => {
    const id = requireServer(ctx, "server.startup");
    const body = await ctx.body<{ preset?: string }>();
    const preset = String(body.preset ?? "");
    const row = queryOne<{ software: string; memory_mb: number; name: string }>(
      "SELECT software, memory_mb, name FROM servers WHERE id = ?", [id],
    )!;
    const definition = JVM_PRESETS.find((entry) => entry.id === preset);
    if (!definition || definition.id === "custom") {
      throw badRequest("Choose one of the built-in JVM presets. Custom flag strings need full server settings access.");
    }
    /*
     * Defensive: a preset must never *raise* memory. -Xms/-Xmx/-Xss/XX:MaxRAM* would let an account
     * exceed its allocation; a native *cap* such as -XX:MaxDirectMemorySize=128M (art of `lowmem`)
     * only limits, so it is allowed.
     */
    if (/(^|\s)-(Xm[sx]|Xss|XX:MaxRAM|XX:MaxHeapSize|XX:InitialHeapSize)/.test(definition.flags)) {
      throw badRequest("That preset is not allowed here.");
    }
    run("UPDATE servers SET jvm_args = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", [definition.flags, id]);
    const { recordActivity } = await import("../services/audit");
    recordActivity({
      type: "server.startup_preset",
      serverId: id, target: row.name, actorName: ctx.user!.username,
      metadata: { preset: definition.id, label: definition.label, allocationMb: row.memory_mb },
    });
    return json({
      ok: true,
      preset: definition.id,
      restartRequired: true,
      message: `${definition.label} saved. Restart the server for the new flags to take effect.`,
    });
  });

  api.post("/api/servers/:id/reinstall", async (ctx) => {
    const id = requireServer(ctx, "server.settings");
    const body = await ctx.body<{ preserveData?: boolean }>();
    return json(reinstallServer(id, ctx.user!.username, body.preserveData !== false));
  });

  api.get("/api/servers/:id/allocations", async (ctx) => {
    const id = requireServer(ctx, "server.allocations");
    const row = queryOne<{ node_id: number }>("SELECT node_id FROM servers WHERE id = ?", [id])!;
    const available = query<any>(
      `SELECT a.id, a.ip, a.port, a.ip_alias, a.notes FROM allocations a
       WHERE a.node_id = ? AND (a.server_id IS NULL OR a.server_id = ?) ORDER BY a.port`,
      [row.node_id, id],
    );
    return json({ data: available });
  });

  api.post("/api/servers/:id/allocations", async (ctx) => {
    const id = requireServer(ctx, "server.allocations");
    const body = await ctx.body<{ ip?: string; port?: number; notes?: string }>();
    const server = queryOne<{ node_id: number }>("SELECT node_id FROM servers WHERE id = ?", [id])!;
    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw badRequest("Invalid port");
    const ip = String(body.ip ?? "0.0.0.0");
    const existing = queryOne<{ id: number }>("SELECT id FROM allocations WHERE node_id = ? AND ip = ? AND port = ?", [server.node_id, ip, port]);
    if (existing) throw badRequest("That allocation already exists on this node");
    insert("INSERT INTO allocations (node_id, ip, port, server_id, notes) VALUES (?, ?, ?, ?, ?)", [
      server.node_id, ip, port, id, body.notes ?? null,
    ]);
    return json({ ok: true }, { status: 201 });
  });

  /* ---------------- Plugins ---------------- */

  api.get("/api/servers/:id/plugins", async (ctx) => {
    const id = requireServer(ctx);
    const server = queryOne<{ software: string }>("SELECT software FROM servers WHERE id = ?", [id])!;
    const installed = listInstalled(id);
    return json({
      data: listInstalled(id),
      recommended: recommendsPlugins(server.software as ServerSoftwareId)
        ? RECOMMENDED_PLUGINS.map((plugin) => ({
            slug: plugin.slug,
            title: plugin.title,
            note: plugin.note,
            installed: installed.some((entry) =>
              (entry.projectId ?? "").toLowerCase() === plugin.slug
              || entry.fileName.toLowerCase().includes(plugin.slug)),
          }))
        : [],
      loaders: LOADER_MAP[server.software as keyof typeof LOADER_MAP] ?? [],
      directory: server.software === "fabric" || server.software === "forge" || server.software === "neoforge" || server.software === "quilt" ? "mods" : "plugins",
    });
  });

  /** One-click install of the Via stack (ViaVersion + ViaBackwards) for Paper/Purpur. */
  api.post("/api/servers/:id/plugins/recommended", async (ctx) => {
    const id = requireServer(ctx, "server.plugins");
    const result = await installRecommendedPlugins(id, { actor: ctx.user!.username });
    return json(result);
  });

  api.post("/api/servers/:id/plugins/install", async (ctx) => {
    const id = requireServer(ctx, "server.plugins");
    const body = await ctx.body<{ versionId?: string; allowBeta?: boolean }>();
    const versionId = String(body.versionId ?? "");
    if (!versionId) throw badRequest("versionId is required");
    const result = await installVersion(id, versionId, {
      actor: ctx.user!.username,
      allowBeta: body.allowBeta === true,
      installDependencies: true,
    });
    return json(result);
  });

  api.post("/api/servers/:id/plugins/updates", async (ctx) => {
    const id = requireServer(ctx, "server.plugins");
    return json({ data: await checkUpdates(id) });
  });

  api.delete("/api/servers/:id/plugins/:pluginId", async (ctx) => {
    const id = requireServer(ctx, "server.plugins");
    removePlugin(id, Number(ctx.params.pluginId), { actor: ctx.user!.username });
    return json({ ok: true });
  });

  api.get("/api/marketplace/search", async (ctx) => {
    const software = ctx.query("software") ?? undefined;
    const result = await searchProjects({
      query: ctx.query("query") ?? undefined,
      software: software as any,
      gameVersion: ctx.query("gameVersion") ?? undefined,
      category: ctx.query("category") ?? undefined,
      index: (ctx.query("index") as any) ?? "relevance",
      limit: Number(ctx.query("limit") ?? 20),
      offset: Number(ctx.query("offset") ?? 0),
    });
    return json(result);
  });

  api.get("/api/marketplace/project/:id", async (ctx) => {
    const project = await getProject(ctx.params.id);
    return json({ project });
  });

  api.get("/api/marketplace/project/:id/versions", async (ctx) => {
    const versions = await getVersions(ctx.params.id, {
      gameVersion: ctx.query("gameVersion") ?? undefined,
      software: (ctx.query("software") as any) ?? undefined,
    });
    return json({ data: versions });
  });

  /* ---------------- Map ---------------- */

  /**
   * The seed map: the real seed of this server's worlds, plus the exact Chunkbase deep links.
   *
   * The seed is read from `level.dat`, so the map that opens is the map of the world that is actually
   * on disk. Nothing here fetches Chunkbase — the panel only builds a URL, which keeps the page working
   * offline and means no third-party request leaves the host until the operator clicks.
   */
  api.get("/api/servers/:id/seed-map", async (ctx) => {
    const id = requireServer(ctx);
    const server = queryOne<{ uuid: string; mc_version: string; software: string; name: string }>(
      "SELECT uuid, mc_version, software, name FROM servers WHERE id = ?", [id],
    )!;
    const directory = serverDir(server.uuid);
    const detected = detectWorlds(directory);
    const properties = readProperties(directory);
    const mainWorld = properties.values["level-name"] || "world";
    const platform = chunkbasePlatformFor(server.mc_version);

    const worlds = detected.map((world) => ({
      folder: world.folder,
      name: world.name,
      seed: world.seed ?? null,
      lastUpdated: world.lastUpdated ?? null,
      dimensions: world.dimensions ?? { nether: false, end: false },
      isMain: world.folder === mainWorld,
      links: world.seed
        ? {
            overworld: seedMapUrl({ seed: world.seed, platform, dimension: "overworld" }),
            nether: seedMapUrl({ seed: world.seed, platform, dimension: "nether" }),
            end: seedMapUrl({ seed: world.seed, platform, dimension: "end" }),
          }
        : null,
    }));
    const primary = worlds.find((world) => world.isMain) ?? worlds[0] ?? null;

    return json({
      server: { id, name: server.name, software: server.software, mcVersion: server.mc_version },
      platform,
      platformIsExact: platformIsExact(server.mc_version, platform),
      dimensions: CHUNKBASE_DIMENSIONS,
      knownPlatforms: CHUNKBASE_PLATFORMS,
      /** Honest capability report: the site forbids framing, so the panel opens a tab instead. */
      embeddable: false,
      embedBlockedBy: "www.chunkbase.com sends X-Frame-Options: DENY",
      primaryWorld: primary,
      worlds,
      levelName: mainWorld,
    });
  });

  api.get("/api/servers/:id/map", async (ctx) => {
    const id = requireServer(ctx);
    const row = queryOne<any>("SELECT * FROM map_configs WHERE server_id = ?", [id]);
    const server = queryOne<{ uuid: string }>("SELECT uuid FROM servers WHERE id = ?", [id])!;
    const webRoot = join(serverDir(server.uuid), "bluemap", "web");
    const bluemapDir = join(webRoot, "maps");
    const rendered = existsSync(bluemapDir) ? readdirSync(bluemapDir).length : 0;
    const maps = existsSync(bluemapDir)
      ? readdirSync(bluemapDir).filter((entry) => statSync(join(bluemapDir, entry)).isDirectory()).map((entry) => {
          const dir = join(bluemapDir, entry);
          let bytes = 0;
          try {
            const stack = [dir];
            while (stack.length) {
              const current = stack.pop()!;
              for (const item of readdirSync(current, { withFileTypes: true })) {
                const full = join(current, item.name);
                if (item.isDirectory()) stack.push(full);
                else bytes += statSync(full).size;
              }
            }
          } catch { /* size is best-effort */ }
          return { id: entry, sizeBytes: bytes };
        })
      : [];
    return json({
      config: row
        ? {
          serverId: row.server_id, provider: row.provider, status: row.status, progress: row.progress,
          publicUrl: row.public_url, worlds: row.worlds ? JSON.parse(row.worlds) : [], note: row.note, lastUpdate: row.updated_at,
        }
        : {
          serverId: id, provider: "none", status: "not_configured", progress: 0,
          publicUrl: null, worlds: [], note: null, lastUpdate: null,
        },
      renderedMaps: rendered,
      maps,
      webRootExists: existsSync(join(webRoot, "index.html")),
      bluemapInstalled: queryOne("SELECT 1 AS ok FROM plugins WHERE server_id = ? AND lower(file_name) LIKE 'bluemap%'", [id]) !== null,
    });
  });

  /**
   * Serves the renderer's own web output (BlueMap writes into bluemap/web). Only files inside that
   * directory are reachable, and the path is resolved before the containment check, so `..` and
   * symlink escapes cannot leave the map folder.
   */
  api.get("/api/servers/:id/map/web/*", async (ctx) => {
    const id = requireServer(ctx);
    const row = queryOne<{ uuid: string }>("SELECT uuid FROM servers WHERE id = ?", [id])!;
    const webRoot = resolve(join(serverDir(row.uuid), "bluemap", "web"));
    const requested = ctx.params.rest ?? "";
    let candidate = resolve(join(webRoot, requested));
    if (candidate !== webRoot && !candidate.startsWith(webRoot + sep)) throw notFound("Map asset not found");
    if (existsSync(candidate) && statSync(candidate).isDirectory()) candidate = join(candidate, "index.html");
    if (!existsSync(candidate) || !statSync(candidate).isFile()) {
      throw notFound("The renderer has not produced this file yet. Start the server so BlueMap can render the world.");
    }
    return new Response(Bun.file(candidate), {
      headers: {
        "content-type": contentTypeForMapAsset(candidate),
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
      },
    });
  });

  api.post("/api/servers/:id/map/setup", async (ctx) => {
    const id = requireServer(ctx, "server.plugins");
    const server = queryOne<{ software: string; mc_version: string; name: string }>(
      "SELECT software, mc_version, name FROM servers WHERE id = ?", [id],
    )!;
    if (!["paper", "purpur", "folia"].includes(server.software)) {
      throw badRequest("BlueMap can only be installed automatically on Paper, Purpur or Folia servers. On other software install the matching mod manually.");
    }
    const results = await searchProjects({ query: "bluemap", software: "paper", gameVersion: server.mc_version, limit: 5 });
    const hit = results.hits.find((project) => project.slug === "bluemap") ?? results.hits[0];
    if (!hit) throw badRequest("BlueMap was not found on Modrinth for this Minecraft version");
    const versions = await getVersions(hit.project_id, { gameVersion: server.mc_version, software: "paper" });
    const version = versions.find((entry) => entry.version_type === "release") ?? versions[0];
    if (!version) throw badRequest(`BlueMap has no release compatible with Minecraft ${server.mc_version}`);
    const install = await installVersion(id, version.id, { actor: ctx.user!.username, installDependencies: true });
    insert(
      `INSERT INTO map_configs (server_id, provider, status, progress, note)
       VALUES (?, 'bluemap', 'rendering', 0, ?)
       ON CONFLICT(server_id) DO UPDATE SET provider = 'bluemap', status = 'rendering', note = excluded.note,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      [id, "BlueMap installed. Start the server so it can render; map data appears under bluemap/web/maps."],
    );
    return json({
      installed: install,
      message: "BlueMap installed. Start the server to begin rendering — RSLMC reports render progress from the renderer's own output.",
    });
  });
}

/** Content types for renderer assets (BlueMap ships html/js/json/png/prbm). */
function contentTypeForMapAsset(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js":
    case ".mjs": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".svg": return "image/svg+xml";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}

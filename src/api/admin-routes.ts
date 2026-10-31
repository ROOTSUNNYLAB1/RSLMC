import { Router, json, validate, v, badRequest, notFound, pagination, forbidden } from "../shared/http";
import { requirePermission, publicUser, findUserById, rolesForUser, permissionsForUser } from "../auth";
import { hashPassword, checkPasswordPolicy } from "../security/passwords";
import { query, queryOne, insert, run } from "../database";
import { listAudit } from "../services/audit";
import { listRuntimes, installRuntime, removeRuntime, availableAdoptiumReleases, SUPPORTED_JAVA_MAJORS } from "../java/manager";
import { listNotifications, markRead, markAllRead, dismiss, notify } from "../services/notifications";
import { hostStats, diskUsage } from "../resources/host";
import { describeEnforcement } from "../resources/enforcement";
import { detectCgroups, installHelper } from "../resources/cgroups";
import { listServersForUser, listServersForAllocation, setUserServerAccess, mapServer } from "../services/servers";
import { listManaged, shutdownAll, listManaged as managedList } from "../processes/manager";
import { PERMISSIONS, ALL_PERMISSIONS } from "../shared/permissions";
import { backupDatabase, getSetting, setSetting } from "../database";
import { APP_VERSION, MODE, PORT, PATHS, DATA_LOCATION } from "../shared/config";
import { backupStorageSummary } from "../services/backups";
import { pruneOldMetrics } from "../database";
import { recordAudit } from "../services/audit";
import { publicNode, assertNoSelfLoop } from "./node-routes";
import { getNode, probeNode } from "../nodes/client";
import { generateAgentKey } from "../nodes/agent";
import { registrationAdminView, writeRegistrationConfig } from "../services/registration";
import { oauthAdminView, writeOauthConfig } from "../services/oauth";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/**
 * Returns the permissions a set of role names grants, or null when a role does not exist.
 * Used to stop an account with `user.manage` (but not root) from handing out a role that is more
 * powerful than its own — the classic "edit user → become administrator" escalation.
 */
function permissionsOfRoles(roleNames: string[]): string[] | null {
  const out = new Set<string>();
  for (const name of roleNames) {
    const role = queryOne<{ id: number }>("SELECT id FROM roles WHERE name = ?", [name]);
    if (!role) return null;
    for (const row of query<{ permission: string }>("SELECT permission FROM role_permissions WHERE role_id = ?", [role.id])) {
      out.add(row.permission);
    }
  }
  return [...out];
}

function assertCanGrantRoles(actor: { isRoot: boolean; permissions: string[] }, roleNames: string[]): void {
  if (actor.isRoot || roleNames.length === 0) return;
  const granted = permissionsOfRoles(roleNames);
  if (granted === null) return; // unknown role is reported by the caller
  const mine = new Set(actor.permissions);
  const beyond = granted.filter((permission) => permission !== "*" && !mine.has(permission));
  if (beyond.length > 0) {
    throw forbidden(`You cannot grant permissions you do not have yourself (${beyond.slice(0, 3).join(", ")}).`);
  }
}

export function registerAdminRoutes(api: Router): void {
  /* ---------------- Admin overview ---------------- */

  api.get("/api/admin/overview", async (ctx) => {
    requirePermission(ctx.user, ["node.view", "user.view"]);
    const servers = query<any>("SELECT * FROM servers");
    const nodes = query<any>("SELECT * FROM nodes");
    const users = queryOne<{ c: number }>("SELECT COUNT(*) AS c FROM users")?.c ?? 0;
    const playersOnline = queryOne<{ c: number }>("SELECT COUNT(*) AS c FROM players WHERE online = 1")?.c ?? 0;
    const backups = queryOne<{ c: number }>("SELECT COUNT(*) AS c FROM backups")?.c ?? 0;
    const onlineServers = servers.filter((server) => ["online", "starting"].includes(server.status)).length;
    const recent = query<any>(
      `SELECT a.*, s.name AS server_name FROM activity_events a LEFT JOIN servers s ON s.id = a.server_id
       ORDER BY a.id DESC LIMIT 12`,
    );
    const failedOps = queryOne<{ c: number }>(
      "SELECT COUNT(*) AS c FROM activity_events WHERE result = 'failure' AND ts > ?",
      [new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()],
    )?.c ?? 0;
    const disk = diskUsage(PATHS.data);
    return json({
      // The dashboard's "Panel health" card reads its build number from here; it used to be a
      // hard-coded string that never changed with the release.
      panel: {
        version: APP_VERSION,
        mode: MODE,
        uptimeSeconds: Math.floor(process.uptime()),
        bunVersion: Bun.version,
        dataDir: ctx.user?.isRoot ? PATHS.data : null,
      },
      counts: {
        servers: servers.length, onlineServers, offlineServers: servers.length - onlineServers,
        users, nodes: nodes.length,
        onlineNodes: nodes.filter((node) => node.last_heartbeat_at || node.is_local === 1).length,
        playersOnline, backups, failedOps,
        javaRuntimes: queryOne<{ c: number }>("SELECT COUNT(*) AS c FROM java_runtimes")?.c ?? 0,
      },
      resources: {
        allocatedMemoryMb: servers.reduce((sum, server) => sum + server.memory_mb, 0),
        allocatedCpuPercent: servers.reduce((sum, server) => sum + server.cpu_percent, 0),
        disk,
        host: hostStats(),
      },
      servers: servers.slice(0, 8).map(mapServer),
      nodes: nodes.map((node) => ({
        id: node.id, name: node.name, isLocal: node.is_local === 1, fqdn: node.fqdn,
        maintenance: node.maintenance === 1, lastHeartbeatAt: node.last_heartbeat_at,
        online: node.is_local === 1 || Boolean(node.last_heartbeat_at),
      })),
      recentEvents: recent.map((row) => ({
        id: row.id, ts: row.ts, type: row.type, actorName: row.actor_name,
        serverId: row.server_id, serverName: row.server_name, result: row.result, target: row.target,
      })),
      enforcement: describeEnforcement(),
      security: {
        mustChangePasswordUsers: queryOne<{ c: number }>("SELECT COUNT(*) AS c FROM users WHERE must_change_password = 1")?.c ?? 0,
        totpEnabled: queryOne<{ c: number }>("SELECT COUNT(*) AS c FROM users WHERE totp_enabled = 1")?.c ?? 0,
        weakMode: MODE !== "production",
      },
    });
  });

  api.get("/api/system", async (ctx) => {
    requirePermission(ctx.user, "system.manage");
    const cgroups = detectCgroups();
    return json({
      panel: {
        version: APP_VERSION, mode: MODE, port: PORT,
        uptimeSeconds: Math.floor(process.uptime()), bunVersion: Bun.version,
        // Everything (database, servers, Java, backups) lives under this one folder.
        dataDir: PATHS.data, dataDirSource: DATA_LOCATION.source, dataDirNote: DATA_LOCATION.note,
      },
      host: hostStats(),
      enforcement: describeEnforcement(cgroups),
      cgroups,
      managedProcesses: listManaged(),
      backups: backupStorageSummary(),
      settings: query<any>("SELECT key, secret, updated_at FROM settings ORDER BY key").map((row) => ({
        key: row.key, secret: row.secret === 1, updatedAt: row.updated_at,
      })),
    });
  });

  /* ---------------- Self-registration ---------------- */

  api.get("/api/system/registration", async (ctx) => {
    requirePermission(ctx.user, ["system.manage", "user.manage"]);
    return json(registrationAdminView());
  });

  api.put("/api/system/registration", async (ctx) => {
    requirePermission(ctx.user, ["system.manage", "user.manage"]);
    const body = await ctx.body<{
      enabled?: boolean; requireCode?: boolean;
      defaultRole?: string; inviteCode?: string | null;
    }>();
    const patch: Record<string, unknown> = {};
    for (const key of ["enabled", "requireCode"] as const) {
      if (body[key] !== undefined) {
        if (typeof body[key] !== "boolean") throw badRequest(`${key} must be true or false`);
        patch[key] = body[key];
      }
    }
    if (body.defaultRole !== undefined) patch.defaultRole = String(body.defaultRole);
    if (body.inviteCode !== undefined) {
      patch.inviteCode = body.inviteCode === null ? null : String(body.inviteCode);
    }
    const config = writeRegistrationConfig(patch);
    recordAudit({
      actorId: ctx.user!.id, actorName: ctx.user!.username, action: "system.registration_updated",
      ip: ctx.clientIp, metadata: { ...config, inviteCode: config.codeSet ? "(set)" : "(empty)" },
    });
    return json(registrationAdminView());
  });

  /* ---------------- Single sign-on ---------------- */

  api.get("/api/system/oauth", async (ctx) => {
    requirePermission(ctx.user, ["system.manage", "user.manage"]);
    return json(oauthAdminView());
  });

  api.put("/api/system/oauth", async (ctx) => {
    requirePermission(ctx.user, ["system.manage", "user.manage"]);
    const body = await ctx.body<Record<string, unknown>>();
    const result = writeOauthConfig(body as any);
    recordAudit({
      actorId: ctx.user!.id, actorName: ctx.user!.username, action: "system.oauth_updated",
      ip: ctx.clientIp,
      // Secrets never reach the audit trail; only which provider was touched and whether a
      // credential is stored (the key names avoid the audit redactor so booleans stay readable).
      metadata: {
        discord: { enabled: result.discord.enabled, clientId: result.discord.clientId, hasCredential: result.discord.secretSet },
        google: {
          enabled: result.google.enabled, clientId: result.google.clientId,
          hasCredential: result.google.secretSet, hasFirebase: result.google.firebaseApiKeySet,
        },
        allowRegistration: result.allowRegistration,
        linkByEmail: result.linkByEmail,
      },
    });
    return json(oauthAdminView());
  });

  api.delete("/api/users/:id/identities/:provider", async (ctx) => {
    requirePermission(ctx.user, "user.manage");
    const userId = Number(ctx.params.id);
    const { unlinkIdentity } = await import("../services/oauth");
    unlinkIdentity(userId, String(ctx.params.provider));
    recordAudit({
      actorId: ctx.user!.id, actorName: ctx.user!.username, action: "user.identity_unlinked",
      ip: ctx.clientIp, targetType: "user", targetId: userId, metadata: { provider: ctx.params.provider },
    });
    return json({ ok: true });
  });

  api.post("/api/system/cgroups/install", async (ctx) => {
    requirePermission(ctx.user, "system.manage");
    const result = installHelper();
    recordAudit({
      actorId: ctx.user!.id, actorName: ctx.user!.username, action: "system.cgroup_helper_install",
      ip: ctx.clientIp, result: result.ok ? "success" : "failure", metadata: { message: result.message },
    });
    return json(result);
  });

  api.post("/api/system/maintenance", async (ctx) => {
    requirePermission(ctx.user, "system.manage");
    const body = await ctx.body<{ task?: string }>();
    switch (body.task) {
      case "prune-metrics": {
        const days = Number(getSetting("metrics.retentionDays", "14"));
        pruneOldMetrics(days * 86400_000);
        return json({ ok: true, message: `Metrics older than ${days} days were removed` });
      }
      case "backup-database": {
        const destination = join(PATHS.backups, `panel-${Date.now()}.db`);
        backupDatabase(destination);
        return json({ ok: true, message: `Database snapshot written to ${destination}` });
      }
      case "checkpoint": {
        const { getDb } = await import("../database");
        getDb().exec("PRAGMA wal_checkpoint(TRUNCATE);");
        return json({ ok: true, message: "WAL checkpoint completed" });
      }
      case "reload-scheduler": {
        const { stopScheduler, startScheduler } = await import("../services/schedules");
        stopScheduler(); startScheduler();
        return json({ ok: true, message: "Scheduler reloaded" });
      }
      default:
        throw badRequest("Unknown maintenance task");
    }
  });

  /* ---------------- Nodes ---------------- */

  api.get("/api/nodes", async (ctx) => {
    requirePermission(ctx.user, "node.view");
    const nodes = query<any>("SELECT * FROM nodes ORDER BY is_local DESC, id");
    return json({ data: nodes.map((node) => publicNode(node)) });
  });

  api.post("/api/nodes", async (ctx) => {
    requirePermission(ctx.user, "node.manage");
    const body = await ctx.body();
    const input = validate(
      {
        name: v.string({ min: 2, max: 60, pattern: /^[A-Za-z0-9 _.-]+$/ }),
        description: v.string({ max: 300, optional: true }),
        fqdn: v.string({ min: 3, max: 253 }),
        scheme: v.oneOf(["http", "https"] as const),
        port: v.number({ integer: true, min: 1, max: 65535 }),
        location: v.string({ max: 120, optional: true }),
        public: v.boolean({ optional: true }),
      },
      body,
    );
    const exists = queryOne("SELECT id FROM nodes WHERE name = ?", [input.name]);
    if (exists) throw badRequest("A node with that name already exists");
    // A node that points at this very panel would forward requests into a loop.
    assertNoSelfLoop(
      { scheme: input.scheme!, fqdn: input.fqdn!, port: input.port! } as any,
      PORT,
    );

    /*
     * The agent key is generated here and shown exactly once. It is stored on the controller (it has
     * to be sent with every request) and must be pasted into the node's own panel — that is the whole
     * enrolment: the node decides whether to trust the controller, not the other way round.
     */
    const agentKey = generateAgentKey();
    const id = insert(
      `INSERT INTO nodes (uuid, name, description, fqdn, scheme, port, location, public, agent_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(), input.name, input.description ?? null, input.fqdn, input.scheme,
        input.port, input.location ?? null, input.public === false ? 0 : 1, agentKey,
      ],
    );
    recordAudit({ actorId: ctx.user!.id, actorName: ctx.user!.username, action: "node.created", ip: ctx.clientIp, targetType: "node", targetId: id });

    // Say hello straight away so the page can tell the operator whether the address is reachable.
    const node = getNode(id)!;
    const probe = await probeNode(node);
    const refreshed = getNode(id)!;
    return json(
      {
        id,
        agentKey,
        node: publicNode(refreshed),
        reachable: probe.ok,
        probeError: probe.error,
        message: probe.ok
          ? "Node registered and reachable. Paste the agent key into that panel to finish enrolling it."
          : "Node registered. It is not answering yet — finish enrolling it on that machine, then press Test connection.",
      },
      { status: 201 },
    );
  });

  api.patch("/api/nodes/:id", async (ctx) => {
    requirePermission(ctx.user, "node.manage");
    const body = await ctx.body<{ name?: string; description?: string; maintenance?: boolean; public?: boolean; location?: string }>();
    const node = queryOne<any>("SELECT * FROM nodes WHERE id = ?", [Number(ctx.params.id)]);
    if (!node) throw notFound("Node not found");
    run("UPDATE nodes SET name = ?, description = ?, maintenance = ?, public = ?, location = ? WHERE id = ?", [
      body.name ?? node.name, body.description ?? node.description,
      (body.maintenance ?? node.maintenance === 1) ? 1 : 0,
      (body.public ?? node.public === 1) ? 1 : 0,
      body.location ?? node.location, node.id,
    ]);
    return json({ ok: true });
  });

  api.delete("/api/nodes/:id", async (ctx) => {
    requirePermission(ctx.user, "node.manage");
    const node = queryOne<{ id: number; is_local: number }>("SELECT id, is_local FROM nodes WHERE id = ?", [Number(ctx.params.id)]);
    if (!node) throw notFound("Node not found");
    if (node.is_local === 1) throw badRequest("The local node cannot be deleted");
    const servers = queryOne<{ c: number }>("SELECT COUNT(*) AS c FROM servers WHERE node_id = ?", [node.id])?.c ?? 0;
    if (servers > 0) throw badRequest(`This node still hosts ${servers} server(s). Migrate or delete them first.`);
    run("DELETE FROM nodes WHERE id = ?", [node.id]);
    recordAudit({ actorId: ctx.user!.id, actorName: ctx.user!.username, action: "node.deleted", ip: ctx.clientIp, targetId: node.id });
    return json({ ok: true });
  });

  /* ---------------- Users & roles ---------------- */

  api.get("/api/users", async (ctx) => {
    requirePermission(ctx.user, "user.view");
    const { page, perPage, offset } = pagination(ctx.url, 50);
    const rows = query<any>("SELECT * FROM users ORDER BY id LIMIT ? OFFSET ?", [perPage, offset]);
    const total = queryOne<{ c: number }>("SELECT COUNT(*) AS c FROM users")?.c ?? 0;
    return json({
      data: rows.map((row) => ({
        id: row.id, username: row.username, email: row.email, isRoot: row.is_root === 1,
        mustChangePassword: row.must_change_password === 1, totpEnabled: row.totp_enabled === 1,
        disabled: row.disabled === 1, roles: rolesForUser(row.id), createdAt: row.created_at,
        lastLoginAt: row.last_login_at, avatarColor: row.avatar_color,
        avatarUrl: row.avatar_file ? `/api/users/${row.id}/avatar?v=${row.avatar_version ?? 0}` : null,
        // Which sign-in providers this account can use (empty for password-only accounts).
        identities: query<{ provider: string }>("SELECT provider FROM user_identities WHERE user_id = ?", [row.id]).map((entry) => entry.provider),
      })),
      page, perPage, total, totalPages: Math.ceil(total / perPage),
    });
  });

  api.post("/api/users", async (ctx) => {
    requirePermission(ctx.user, "user.manage");
    const body = await ctx.body();
    const input = validate(
      {
        username: v.string({ min: 3, max: 32, pattern: /^[A-Za-z0-9_.-]+$/ }),
        email: v.string({ max: 200, optional: true }),
        password: v.string({ min: 10, max: 200 }),
        roles: v.array((value) => String(value), { optional: true }),
        isRoot: v.boolean({ optional: true }),
      },
      body,
    );
    const newUsername = input.username!;
    // Root is not a role: only a root administrator can mint another one.
    if (input.isRoot && !ctx.user!.isRoot) throw forbidden("Only a root administrator can create a root account.");
    assertCanGrantRoles(ctx.user!, input.roles ?? []);
    const exists = queryOne("SELECT id FROM users WHERE lower(username) = lower(?)", [newUsername]);
    if (exists) throw badRequest("That username is already taken");
    const policy = checkPasswordPolicy(input.password!);
    if (!policy.ok) throw badRequest("Password does not meet the requirements", policy.problems);
    const id = insert("INSERT INTO users (username, email, password_hash, is_root) VALUES (?, ?, ?, ?)", [
      newUsername, input.email ?? null, await hashPassword(input.password!), input.isRoot ? 1 : 0,
    ]);
    for (const roleName of input.roles ?? []) {
      const role = queryOne<{ id: number }>("SELECT id FROM roles WHERE name = ?", [roleName]);
      if (role) run("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)", [id, role.id]);
    }
    recordAudit({ actorId: ctx.user!.id, actorName: ctx.user!.username, action: "user.created", ip: ctx.clientIp, targetType: "user", targetId: id });
    return json({ id }, { status: 201 });
  });

  api.patch("/api/users/:id", async (ctx) => {
    requirePermission(ctx.user, "user.manage");
    const userId = Number(ctx.params.id);
    const user = findUserById(userId);
    if (!user) throw notFound("User not found");
    const body = await ctx.body<{ email?: string; roles?: string[]; disabled?: boolean; isRoot?: boolean; mustChangePassword?: boolean }>();
    /*
     * Escalation guards: without them an account holding `user.manage` could PATCH itself to
     * is_root = 1 (bypassing every permission check), edit a root account, or hand itself a role it
     * was never given. Root-ness can only be granted — and taken — by a root administrator.
     */
    if (user.is_root === 1 && !ctx.user!.isRoot) {
      throw forbidden("Only a root administrator can modify a root account.");
    }
    if (body.isRoot !== undefined && !ctx.user!.isRoot) {
      throw forbidden("Only a root administrator can change root access.");
    }
    if (userId === ctx.user!.id && body.isRoot === false) {
      throw badRequest("You cannot remove your own root access. Ask another root administrator.");
    }
    if (Array.isArray(body.roles)) assertCanGrantRoles(ctx.user!, body.roles);
    run("UPDATE users SET email = ?, disabled = ?, is_root = ?, must_change_password = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", [
      body.email ?? user.email, (body.disabled ?? user.disabled === 1) ? 1 : 0,
      (body.isRoot ?? user.is_root === 1) ? 1 : 0, (body.mustChangePassword ?? user.must_change_password === 1) ? 1 : 0,
      userId,
    ]);
    if (Array.isArray(body.roles)) {
      run("DELETE FROM user_roles WHERE user_id = ?", [userId]);
      for (const roleName of body.roles) {
        const role = queryOne<{ id: number }>("SELECT id FROM roles WHERE name = ?", [roleName]);
        if (role) run("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)", [userId, role.id]);
      }
    }
    recordAudit({ actorId: ctx.user!.id, actorName: ctx.user!.username, action: "user.updated", ip: ctx.clientIp, targetType: "user", targetId: userId });
    return json({ ok: true });
  });

  api.get("/api/users/:id/servers", async (ctx) => {
    requirePermission(ctx.user, "user.view");
    const userId = Number(ctx.params.id);
    const user = findUserById(userId);
    if (!user) throw notFound("User not found");
    return json({
      user: { id: userId, username: user.username },
      data: listServersForAllocation(userId),
    });
  });

  api.put("/api/users/:id/servers", async (ctx) => {
    requirePermission(ctx.user, "user.manage");
    const userId = Number(ctx.params.id);
    const user = findUserById(userId);
    if (!user) throw notFound("User not found");
    if (user.is_root) throw badRequest("Root administrators already have access to every server.");
    const body = await ctx.body<{ owner?: number[]; shared?: number[] }>();
    const toIds = (value: unknown): number[] => {
      if (value === undefined || value === null) return [];
      if (!Array.isArray(value)) throw badRequest("owner and shared must be arrays of server ids");
      return value.map((entry) => Number(entry)).filter((entry) => Number.isInteger(entry) && entry > 0);
    };
    const result = setUserServerAccess(userId, {
      owner: toIds(body.owner),
      shared: toIds(body.shared),
      // Taking a server away from an account hands it to the administrator doing the change.
      reassignOwnerTo: ctx.user!.id,
    });
    recordAudit({
      actorId: ctx.user!.id, actorName: ctx.user!.username, action: "user.servers_updated",
      ip: ctx.clientIp, targetType: "user", targetId: userId, metadata: result,
    });
    notify({
      userId,
      severity: "info",
      kind: "server_access",
      title: "Your server access was updated",
      body: [
        result.ownerAdded.length ? `You now own ${result.ownerAdded.length} server(s).` : null,
        result.sharedAdded.length ? `You were given access to ${result.sharedAdded.length} server(s).` : null,
        result.ownerRemoved.length || result.sharedRemoved.length
          ? `${result.ownerRemoved.length + result.sharedRemoved.length} server(s) were removed from your account.`
          : null,
      ].filter(Boolean).join(" ") || "No server access changed.",
      link: "/servers",
    });
    return json({ ok: true, ...result });
  });

  api.post("/api/users/:id/password", async (ctx) => {
    requirePermission(ctx.user, "user.manage");
    const userId = Number(ctx.params.id);
    const target = findUserById(userId);
    if (!target) throw notFound("User not found");
    // Resetting a root account's password would be a takeover, so it stays with root.
    if (target.is_root === 1 && !ctx.user!.isRoot) {
      throw forbidden("Only a root administrator can reset a root account's password.");
    }
    const body = await ctx.body<{ password?: string }>();
    const password = String(body.password ?? "");
    const policy = checkPasswordPolicy(password);
    if (!policy.ok) throw badRequest("Password does not meet the requirements", policy.problems);
    run("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?", [await hashPassword(password), userId]);
    run("DELETE FROM sessions WHERE user_id = ?", [userId]);
    recordAudit({ actorId: ctx.user!.id, actorName: ctx.user!.username, action: "user.password_reset", ip: ctx.clientIp, targetType: "user", targetId: userId });
    return json({ ok: true });
  });

  api.delete("/api/users/:id", async (ctx) => {
    requirePermission(ctx.user, "user.manage");
    const userId = Number(ctx.params.id);
    if (userId === ctx.user!.id) throw badRequest("You cannot delete your own account");
    const owned = queryOne<{ c: number }>("SELECT COUNT(*) AS c FROM servers WHERE owner_id = ?", [userId])?.c ?? 0;
    if (owned > 0) throw badRequest(`This user owns ${owned} server(s). Transfer ownership first.`);
    run("DELETE FROM users WHERE id = ?", [userId]);
    recordAudit({ actorId: ctx.user!.id, actorName: ctx.user!.username, action: "user.deleted", ip: ctx.clientIp, targetType: "user", targetId: userId });
    return json({ ok: true });
  });

  api.get("/api/roles", async (ctx) => {
    requirePermission(ctx.user, "user.view");
    const roles = query<any>("SELECT * FROM roles ORDER BY id").map((role) => ({
      id: role.id, name: role.name, description: role.description, isSystem: role.is_system === 1,
      permissions: query<{ permission: string }>("SELECT permission FROM role_permissions WHERE role_id = ?", [role.id]).map((row) => row.permission),
      userCount: queryOne<{ c: number }>("SELECT COUNT(*) AS c FROM user_roles WHERE role_id = ?", [role.id])?.c ?? 0,
    }));
    return json({ data: roles, catalogue: PERMISSIONS });
  });

  api.post("/api/roles", async (ctx) => {
    requirePermission(ctx.user, "role.manage");
    const body = await ctx.body<{ name?: string; description?: string; permissions?: string[] }>();
    const name = String(body.name ?? "").trim();
    if (!name) throw badRequest("Role name is required");
    if (queryOne("SELECT id FROM roles WHERE name = ?", [name])) throw badRequest("That role already exists");
    const id = insert("INSERT INTO roles (name, description) VALUES (?, ?)", [name, body.description ?? null]);
    for (const permission of body.permissions ?? []) {
      if (ALL_PERMISSIONS.includes(permission as any)) {
        run("INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES (?, ?)", [id, permission]);
      }
    }
    return json({ id }, { status: 201 });
  });

  api.patch("/api/roles/:id", async (ctx) => {
    requirePermission(ctx.user, "role.manage");
    const roleId = Number(ctx.params.id);
    const role = queryOne<any>("SELECT * FROM roles WHERE id = ?", [roleId]);
    if (!role) throw notFound("Role not found");
    if (role.is_system === 1 && role.name === "Administrator") throw badRequest("The Administrator role cannot be modified");
    const body = await ctx.body<{ name?: string; description?: string; permissions?: string[] }>();
    run("UPDATE roles SET name = ?, description = ? WHERE id = ?", [body.name ?? role.name, body.description ?? role.description, roleId]);
    if (Array.isArray(body.permissions)) {
      run("DELETE FROM role_permissions WHERE role_id = ?", [roleId]);
      for (const permission of body.permissions) {
        if (ALL_PERMISSIONS.includes(permission as any)) {
          run("INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES (?, ?)", [roleId, permission]);
        }
      }
    }
    recordAudit({ actorId: ctx.user!.id, actorName: ctx.user!.username, action: "role.updated", ip: ctx.clientIp, targetId: roleId });
    return json({ ok: true });
  });

  /* ---------------- Audit ---------------- */

  api.get("/api/audit", async (ctx) => {
    requirePermission(ctx.user, "audit.view");
    const { page, perPage, offset } = pagination(ctx.url, 40);
    const result = listAudit({
      search: ctx.query("search") ?? undefined,
      action: ctx.query("action") ?? undefined,
      limit: perPage,
      offset,
    });
    return json({ ...result, page, perPage, totalPages: Math.ceil(result.total / perPage) });
  });

  /* ---------------- Java runtimes ---------------- */

  api.get("/api/java", async (ctx) => {
    requirePermission(ctx.user, "java.manage");
    const releases = await availableAdoptiumReleases().catch(() => []);
    return json({
      data: listRuntimes(),
      supportedMajors: SUPPORTED_JAVA_MAJORS,
      availableUpstream: releases,
      cgroups: detectCgroups(),
    });
  });

  api.post("/api/java/install", async (ctx) => {
    requirePermission(ctx.user, "java.manage");
    const body = await ctx.body<{ major?: number }>();
    const major = Number(body.major);
    if (!SUPPORTED_JAVA_MAJORS.includes(major as any)) throw badRequest(`Java must be one of ${SUPPORTED_JAVA_MAJORS.join(", ")}`);
    const runtime = await installRuntime(major, { nodeId: null });
    recordAudit({ actorId: ctx.user!.id, actorName: ctx.user!.username, action: "java.installed", ip: ctx.clientIp, metadata: { major } });
    return json({ runtime }, { status: 201 });
  });

  api.delete("/api/java/:id", async (ctx) => {
    requirePermission(ctx.user, "java.manage");
    removeRuntime(Number(ctx.params.id));
    recordAudit({ actorId: ctx.user!.id, actorName: ctx.user!.username, action: "java.removed", ip: ctx.clientIp, targetId: ctx.params.id });
    return json({ ok: true });
  });

  /* ---------------- Notifications ---------------- */

  api.get("/api/notifications", async (ctx) => {
    if (!ctx.user) throw notFound();
    const result = listNotifications(ctx.user.id, Number(ctx.query("limit") ?? 50));
    return json(result);
  });

  api.post("/api/notifications/:id/read", async (ctx) => {
    if (!ctx.user) throw notFound();
    markRead(ctx.user.id, Number(ctx.params.id));
    return json({ ok: true });
  });

  api.post("/api/notifications/read-all", async (ctx) => {
    if (!ctx.user) throw notFound();
    markAllRead(ctx.user.id);
    return json({ ok: true });
  });

  api.delete("/api/notifications/:id", async (ctx) => {
    if (!ctx.user) throw notFound();
    dismiss(ctx.user.id, Number(ctx.params.id));
    return json({ ok: true });
  });

  /* ---------------- Global activity ---------------- */

  api.get("/api/activity", async (ctx) => {
    requirePermission(ctx.user, "server.view");
    const { page, perPage, offset } = pagination(ctx.url, 40);
    const { listActivity } = await import("../services/audit");
    const result = listActivity({
      types: ctx.query("types")?.split(",").filter(Boolean),
      search: ctx.query("search") ?? undefined,
      limit: perPage, offset,
    });
    return json({ ...result, page, perPage, totalPages: Math.ceil(result.total / perPage) });
  });
}

import { json, ApiException } from "../shared/http";
import { run } from "../database";
import { SESSION_COOKIE, validateSession, canAccessServer, hasPermission } from "../auth";
import { parseCookies } from "../shared/http";
import { nodeRequest, rewriteForNode, getNode, markNodeDown, type NodeRow } from "./client";
import type { Permission } from "../shared/permissions";
import { recordActivity } from "../services/audit";
import { checkOrigin } from "../security/origin";
import { rateLimit } from "../security/ratelimit";

/**
 * Forwarding a per-server request to the node that owns it.
 *
 * The controller is the only place that knows about users, roles and ownership, so the permission
 * check happens here, before anything leaves the machine. The node answers as if the request had
 * been made by its own administrator, which is why the check above is not optional.
 *
 * What is forwarded is the request as the browser sent it, minus the session cookie and CSRF token:
 * the node has no idea what those mean, and forwarding them would let a stolen cookie from one panel
 * look interesting to another.
 */

/**
 * Which permission a per-server sub-path needs — an explicit table, deny by default.
 *
 * The node applies a forwarded request as its own administrator (`nodeControllerUser()`), so this
 * table *is* the authorisation boundary for remote servers. It used to fall through to
 * `server.view` for anything it did not recognise, which handed `PATCH /api/servers/<id>` (memory,
 * JVM arguments, port), `/reinstall`, `/startup-options`, `/map/setup` and `/eula` to an account that
 * could only read. It also decided the power action from the URL, where `/power` never contains it.
 *
 * Rules:
 *   · Reads fall back to `server.view` — read-only, and the local routes agree.
 *   · Writes are enumerated. Anything not in the table is refused (`null`), never guessed.
 *   · `POST /power` is decided by the request body's `action`.
 */
const READ_FALLBACK: Permission = "server.view";

/** Write paths, longest prefix first. `""` is the server itself. */
const WRITE_TABLE: Array<{ prefix: string; permission: Permission }> = [
  { prefix: "/backups/", permission: "server.backups" },
  { prefix: "/backups", permission: "server.backups" },
  { prefix: "/schedules", permission: "server.schedules" },
  { prefix: "/players", permission: "server.players" },
  { prefix: "/worlds", permission: "server.worlds" },
  { prefix: "/plugins", permission: "server.plugins" },
  { prefix: "/marketplace", permission: "server.plugins" },
  { prefix: "/properties", permission: "server.files" },
  { prefix: "/files", permission: "server.files" },
  { prefix: "/allocations", permission: "server.allocations" },
  { prefix: "/settings", permission: "server.settings" },
  { prefix: "/startup-options", permission: "server.settings" },
  { prefix: "/reinstall", permission: "server.settings" },
  { prefix: "/eula", permission: "server.settings" },
  { prefix: "/map/setup", permission: "server.settings" },
  { prefix: "/map", permission: "server.view" },
  { prefix: "/console", permission: "server.command" },
  { prefix: "", permission: "server.settings" },
];

/** Maps a `POST /power` body action to the permission the local route would check. */
const POWER_ACTIONS: Record<string, Permission> = {
  start: "server.start",
  restart: "server.restart",
  stop: "server.stop",
  kill: "server.kill",
};

export interface PermissionLookup {
  /** `null` means "this panel does not forward this write" — fail closed, not open. */
  permission: Permission | null;
  /** Present when the answer is `null`, for the log line and the 403 message. */
  reason?: string;
}

export function permissionForPath(method: string, subPath: string, body?: unknown): PermissionLookup {
  const path = subPath.split("?")[0]!.toLowerCase();
  const write = method !== "GET" && method !== "HEAD";
  if (!write) {
    // Reads are enumerated only to pick a *narrower* permission than view where one is meant.
    if (path.startsWith("/files")) return { permission: "server.files" };
    if (path.startsWith("/backups")) return { permission: "server.backups" };
    if (path.startsWith("/schedules")) return { permission: "server.schedules" };
    if (path.startsWith("/worlds")) return { permission: "server.worlds" };
    if (path.startsWith("/allocations")) return { permission: "server.allocations" };
    if (path.startsWith("/startup-options")) return { permission: "server.settings" };
    return { permission: READ_FALLBACK };
  }
  if (path.startsWith("/power")) {
    const action = String((body as { action?: unknown } | undefined)?.action ?? "").toLowerCase();
    const permission = POWER_ACTIONS[action];
    if (!permission) return { permission: null, reason: `unknown power action “${action || "(none)"}”` };
    return { permission };
  }
  if (path.startsWith("/console")) return { permission: "server.command" };
  const hit = WRITE_TABLE.find((row) => row.prefix === "" || path.startsWith(row.prefix));
  if (!hit) return { permission: null, reason: `no permission rule for ${method} ${path || "/"}` };
  return { permission: hit.permission };
}

export interface ProxyOutcome {
  handled: false;
} 

/**
 * Returns a Response when the path belonged to a remote server (and was forwarded), or null to let
 * normal local routing continue.
 */
export async function proxyServerRequest(req: Request, url: URL, clientIp: string): Promise<Response | null> {
  const match = /^\/api\/servers\/(\d+)(\/.*)?$/.exec(url.pathname);
  if (!match) return null;
  const serverId = Number(match[1]);
  const subPath = match[2] ?? "";
  const target = rewriteForNode(serverId, url.pathname);
  if (!target) return null;

  /*
   * Deleting a remote server is not a plain forward: the controller's own record, its port
   * allocation and the link row have to disappear too, and only the local route knows how to do
   * that cleanly. It forwards to the node itself (services/servers.ts → deleteServer).
   */
  if (req.method === "DELETE" && subPath === "") return null;

  // --- Who is asking? ------------------------------------------------------------
  const cookies = parseCookies(req.headers.get("cookie"));
  const token = cookies[SESSION_COOKIE];
  const session = token ? validateSession(token) : null;
  if (!session) return json({ error: { code: "unauthorized", message: "Authentication required" } }, { status: 401 });
  const user = session.user;

  // The generic limiter in api/index.ts is never reached for a forwarded request.
  if (req.method !== "GET" && req.method !== "HEAD") {
    const limiter = rateLimit(`api:${clientIp}:${url.pathname}`, 120, 60_000);
    if (!limiter.allowed) {
      return json(
        { error: { code: "rate_limited", message: `Slow down — retry in ${limiter.retryAfterSeconds}s` } },
        { status: 429, headers: { "retry-after": String(limiter.retryAfterSeconds) } },
      );
    }
  }

  /*
   * The body is needed for `/power` (the action lives there, not in the URL) and, for that path
   * only, is re-attached afterwards so the node still receives it.
   */
  const safe = req.method === "GET" || req.method === "HEAD";
  let peeked: unknown = null;
  let replay: ArrayBuffer | null = null;
  if (!safe) {
    // Only two writes need the body here; uploads must keep streaming straight to the node.
    const needsBody = subPath.startsWith("/power") || (req.method === "PATCH" && subPath === "");
    if (needsBody) {
      replay = await req.clone().arrayBuffer().catch(() => null);
      try {
        peeked = JSON.parse(new TextDecoder().decode(replay ?? new ArrayBuffer(0)));
      } catch { peeked = null; }
    }
    // Same second lock the local routes get (api/index.ts): it is skipped by the early return above.
    const decision = checkOrigin({
      origin: req.headers.get("origin"),
      url,
      headers: req.headers,
      publicUrl: process.env.RSLMC_PUBLIC_URL ?? null,
    });
    if (!decision.allowed) {
      console.log(
        `[rslmc] 403 origin_invalid (node forward) ${req.method} ${url.pathname} — origin=${req.headers.get("origin")} ` +
        `host=${req.headers.get("host")} x-forwarded-host=${req.headers.get("x-forwarded-host") ?? "-"} accepted=${decision.considered.join(",") || "-"}`,
      );
      return json(
        {
          error: {
            code: "origin_invalid",
            message:
              `Cross-origin request rejected: the browser sent Origin ${req.headers.get("origin")}, but this panel ` +
              `answers on ${decision.considered.join(", ") || "an unknown host"}. If a reverse proxy or tunnel sits in ` +
              "front of RSLMC, set RSLMC_PUBLIC_URL to the address you opened the panel on.",
          },
        },
        { status: 403 },
      );
    }
  }

  const lookup = permissionForPath(req.method, subPath, peeked);
  if (!lookup.permission) {
    return json(
      {
        error: {
          code: "unsupported_action",
          message: `RSLMC will not forward ${req.method} ${subPath || "/"} to a remote node (${lookup.reason}).`,
        },
      },
      { status: 403 },
    );
  }
  const needed = lookup.permission;
  if (!hasPermission(user, needed)) {
    return json({ error: { code: "forbidden", message: `You need the "${needed}" permission for this action.` } }, { status: 403 });
  }
  if (!canAccessServer(user, serverId)) {
    return json({ error: { code: "not_found", message: "Server not found" } }, { status: 404 });
  }

  // --- CSRF, same rule as local routes -------------------------------------------
  if (!safe) {
    const header = req.headers.get("x-csrf-token");
    if (!header || header !== session.csrfToken) {
      return json({ error: { code: "csrf_invalid", message: "Invalid or missing CSRF token. Reload the panel and try again." } }, { status: 403 });
    }
  }

  const node = target.node;
  const search = url.search;
  const forwardedPath = `${target.path}${search}`;
  const headers: Record<string, string> = { "x-rslmc-controller-user": user.username };
  const contentType = req.headers.get("content-type");
  if (contentType) headers["content-type"] = contentType;
  const accept = req.headers.get("accept");
  if (accept) headers.accept = accept;

  // The body is streamed to the node, so a copy of the JSON has to be taken before it is consumed.
  const settingsEcho = req.method === "PATCH" && subPath === ""
    ? (() => { try { return JSON.parse(new TextDecoder().decode(replay ?? new ArrayBuffer(0))); } catch { return null; } })()
    : null;

  const response = await nodeRequest(node, forwardedPath, {
    method: req.method,
    rawBody: safe ? undefined : (replay ?? (req.body as BodyInit | null) ?? undefined),
    headers,
    // Uploading a world or downloading a backup can legitimately take minutes.
    timeoutMs: 120_000,
  });

  if (response.status === 0) {
    markNodeDown(node, "no answer");
    return json(
      { error: { code: "node_unreachable", message: `Node "${node.name}" did not answer. Its servers are managed on that machine; check that it is running and reachable.` } },
      { status: 502 },
    );
  }

  // A settings change on a remote server has to show up in the controller's own row as well, or the
  // server list would keep showing the old memory/name until the next inventory sync.
  if (settingsEcho && response.status < 400) {
    try { await syncLocalSettings(serverId, settingsEcho as Record<string, unknown>); } catch { /* nothing to sync */ }
  }

  if (!safe && response.status < 400) {
    recordActivity({
      type: "node.request", actorName: user.username, target: `${node.name}`,
      metadata: { method: req.method, path: url.pathname, ip: clientIp, status: response.status },
    });
  }

  const passthrough = new Headers();
  if (response.contentType) passthrough.set("content-type", response.contentType);
  const disposition = response.contentType === "" ? null : null;
  if (disposition) passthrough.set("content-disposition", disposition);
  if (response.bytes) {
    return new Response(new Uint8Array(response.bytes), { status: response.status, headers: passthrough });
  }
  /*
   * The node answers with *its* ids and *its* node name. Passing those through unchanged would leave
   * the page showing a different server id than the one in the address bar — every follow-up click
   * would then 404. So the ids are translated back before the answer leaves the panel.
   */
  return json(remapIds(response.body, serverId, target.remoteId, node), { status: response.status, headers: passthrough });
}

export function remoteNodeFor(serverId: number): NodeRow | null {
  const target = rewriteForNode(serverId, `/api/servers/${serverId}`);
  return target ? getNode(target.node.id) : null;
}

export function assertNodeUsable(node: NodeRow, action: string): void {
  if (node.maintenance === 1) {
    throw new ApiException(409, "node_maintenance", `Node "${node.name}" is in maintenance mode — ${action} is paused there.`);
  }
}


/**
 * Translates a node's identifiers back into the controller's.
 *
 * Only the fields that actually name a server (and the node it runs on) are touched — a blanket
 * "replace every number that matches" would corrupt things like port numbers or byte counts that
 * happen to be equal.
 */
function remapIds(body: unknown, controllerId: number, remoteId: number, node: NodeRow): unknown {
  if (!body || typeof body !== "object") return body;
  const walk = (value: any): any => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== "object") return value;
    const out: Record<string, any> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === "serverId" && typeof entry === "number" && entry === remoteId) { out[key] = controllerId; continue; }
      if (key === "server" && entry && typeof entry === "object" && !Array.isArray(entry)) {
        const copy = walk(entry) as any;
        if (copy && typeof copy === "object" && copy.id === remoteId) copy.id = controllerId;
        out[key] = copy;
        continue;
      }
      out[key] = walk(entry);
    }
    // A bare server object at the top level (GET /api/servers/:id).
    if (out.id === remoteId && ("uuid" in out || "mcVersion" in out)) {
      out.id = controllerId;
      out.nodeId = node.id;
      out.nodeName = node.name;
      out.remoteServerId = remoteId;
      out.managedByNode = true;
    }
    return out;
  };
  return walk(body);
}


/** Copies the editable fields of a settings update onto the controller's copy of the server. */
async function syncLocalSettings(serverId: number, body: Record<string, unknown>): Promise<void> {
  const columns: Record<string, string> = {
    name: "name",
    description: "description",
    memoryMb: "memory_mb",
    cpuPercent: "cpu_percent",
    diskMb: "disk_mb",
    jvmArgs: "jvm_args",
    serverArgs: "server_args",
    autoStart: "auto_start",
    crashRecovery: "crash_recovery",
    javaMajor: "java_major",
  };
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(columns)) {
    if (!(key in body) || body[key] === undefined) continue;
    sets.push(`${column} = ?`);
    const value = body[key];
    values.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
  }
  if (sets.length === 0) return;
  values.push(serverId);
  run(`UPDATE servers SET ${sets.join(", ")} WHERE id = ?`, values);
}

import { json, ApiException } from "../shared/http";
import { run } from "../database";
import { SESSION_COOKIE, validateSession, canAccessServer, hasPermission } from "../auth";
import { parseCookies } from "../shared/http";
import { nodeRequest, rewriteForNode, getNode, markNodeDown, type NodeRow } from "./client";
import type { Permission } from "../shared/permissions";
import { recordActivity } from "../services/audit";

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

/** Which permission a given per-server sub-path needs. Mirrors the checks in server-routes.ts. */
export function permissionForPath(method: string, subPath: string): Permission {
  const path = subPath.split("?")[0]!.toLowerCase();
  const write = method !== "GET" && method !== "HEAD";
  if (path.startsWith("/files")) return "server.files";
  if (path.startsWith("/backups")) return "server.backups";
  if (path.startsWith("/schedules")) return "server.schedules";
  if (path.startsWith("/players")) return "server.players";
  if (path.startsWith("/worlds")) return "server.worlds";
  if (path.startsWith("/plugins") || path.startsWith("/marketplace")) return "server.plugins";
  if (path.startsWith("/properties")) return "server.files";
  if (path.startsWith("/settings")) return "server.settings";
  if (path.startsWith("/allocations")) return "server.allocations";
  // Lifecycle and console: map the action to the matching permission.
  if (path.startsWith("/power")) {
    if (path.includes("kill")) return "server.kill";
    if (path.includes("stop")) return "server.stop";
    if (path.includes("restart")) return "server.restart";
    return "server.start";
  }
  if (path.startsWith("/console") && write) return "server.command";
  if (path.startsWith("/map")) return "server.view";
  if (path.startsWith("/activity")) return "server.view";
  return "server.view";
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

  const needed = permissionForPath(req.method, subPath);
  if (!hasPermission(user, needed)) {
    return json({ error: { code: "forbidden", message: `You need the "${needed}" permission for this action.` } }, { status: 403 });
  }
  if (!canAccessServer(user, serverId)) {
    return json({ error: { code: "not_found", message: "Server not found" } }, { status: 404 });
  }

  // --- CSRF, same rule as local routes -------------------------------------------
  const safe = req.method === "GET" || req.method === "HEAD";
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
  const settingsEcho = req.method === "PATCH" && subPath === "" ? await req.clone().json().catch(() => null) : null;

  const response = await nodeRequest(node, forwardedPath, {
    method: req.method,
    rawBody: safe ? undefined : (req.body as BodyInit | null) ?? undefined,
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

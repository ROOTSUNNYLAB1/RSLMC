import { queryOne, run, insert } from "../database";
import { ApiException } from "../shared/http";

/**
 * Controller → node transport.
 *
 * Every call to a node goes through here: the token is attached in one place, timeouts and error
 * messages are phrased in one place, and the node's health fields are updated from the same code
 * that talks to it, so "offline" always means "the last real request failed" rather than a guess.
 */

export interface NodeRow {
  id: number;
  uuid: string;
  name: string;
  description: string | null;
  fqdn: string;
  scheme: string;
  port: number;
  location: string | null;
  is_local: number;
  public: number;
  maintenance: number;
  agent_key: string | null;
  daemon_version: string | null;
  last_heartbeat_at: string | null;
  last_status: string | null;
  last_error: string | null;
  stats_json: string | null;
  last_checked_at: string | null;
  api_version: number;
  meta: string | null;
}

// The controller stores the node's agent key encrypted-at-rest? No: it has to send it on every
// request, so it is stored as-is in a dedicated column that no list endpoint ever returns. The
// column is called `agent_key` and is created in migration 013 (see ensureAgentKeyColumn below for
// databases created before it).
const DEFAULT_TIMEOUT_MS = 15_000;

export function nodeBaseUrl(node: Pick<NodeRow, "scheme" | "fqdn" | "port">): string {
  const scheme = node.scheme === "https" ? "https" : "http";
  return `${scheme}://${node.fqdn}:${node.port}`;
}

export function getNode(nodeId: number): NodeRow | null {
  return queryOne<NodeRow>("SELECT * FROM nodes WHERE id = ?", [nodeId]);
}

export function isLocalNode(nodeId: number): boolean {
  const node = queryOne<{ is_local: number }>("SELECT is_local FROM nodes WHERE id = ?", [nodeId]);
  return node?.is_local === 1;
}

export interface NodeResponse {
  ok: boolean;
  status: number;
  body: unknown;
  contentType: string;
  /** Raw bytes, for downloads (backups, files) that must not be parsed. */
  bytes: Uint8Array | null;
}

function errorMessageFor(status: number, body: unknown, node: NodeRow): string {
  const detail = typeof body === "object" && body && "error" in (body as any)
    ? String((body as any).error?.message ?? "")
    : "";
  switch (status) {
    case 401:
    case 403:
      return `Node "${node.name}" rejected the controller key. Re-paste the agent key on that node (Nodes → This panel as a node).`;
    case 404:
      return `Node "${node.name}" does not know this server any more (${detail || "not found"}).`;
    case 502:
    case 503:
    case 504:
      return `Node "${node.name}" is not reachable right now (HTTP ${status}).`;
    default:
      return detail || `Node "${node.name}" answered HTTP ${status}.`;
  }
}

/** A single request to a node. Never throws for HTTP errors — callers decide what to do. */
export async function nodeRequest(
  node: NodeRow,
  path: string,
  init: { method?: string; body?: unknown; rawBody?: BodyInit; headers?: Record<string, string>; timeoutMs?: number; binary?: boolean } = {},
): Promise<NodeResponse> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json, */*", ...init.headers };
  if (node.agent_key) headers.authorization = `Bearer ${node.agent_key}`;
  let body: BodyInit | undefined;
  if (init.rawBody !== undefined) {
    body = init.rawBody;
  } else if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }

  try {
    const response = await fetch(`${nodeBaseUrl(node)}${path}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      // @ts-expect-error Bun needs this for streamed bodies
      duplex: body instanceof ReadableStream ? "half" : undefined,
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (init.binary || !contentType.includes("application/json")) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { ok: response.ok, status: response.status, body: null, contentType, bytes };
    }
    const text = await response.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { error: { message: text.slice(0, 300) } }; }
    return { ok: response.ok, status: response.status, body: parsed, contentType, bytes: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    markNodeDown(node, message);
    return {
      ok: false, status: 0, contentType: "",
      body: { error: { code: "node_unreachable", message: `Node "${node.name}" did not answer: ${message}` } },
      bytes: null,
    };
  }
}

/** Same as nodeRequest() but throws an ApiException carrying a message an operator can act on. */
export async function nodeRequestOrThrow(
  node: NodeRow,
  path: string,
  init: Parameters<typeof nodeRequest>[2] = {},
): Promise<NodeResponse> {
  const response = await nodeRequest(node, path, init);
  if (!response.ok) {
    const status = response.status === 0 ? 502 : response.status >= 400 && response.status < 500 ? response.status : 502;
    throw new ApiException(status, "node_error", errorMessageFor(response.status, response.body, node));
  }
  return response;
}

export interface HandshakeResult {
  ok: boolean;
  version: string | null;
  apiVersion: number;
  fingerprint: string | null;
  stats: any | null;
  servers: { total: number; running: number } | null;
  error: string | null;
  latencyMs: number;
}

/** Says hello to a node and records what it reports. This is what "online" is based on. */
export async function probeNode(node: NodeRow): Promise<HandshakeResult> {
  const started = Date.now();
  const response = await nodeRequest(node, "/api/agent/handshake", { timeoutMs: 8000 });
  const latencyMs = Date.now() - started;
  if (!response.ok || !response.body) {
    const message = errorMessageFor(response.status, response.body, node);
    markNodeDown(node, message);
    return { ok: false, version: null, apiVersion: 0, fingerprint: null, stats: null, servers: null, error: message, latencyMs };
  }
  const payload = response.body as any;
  const version = payload?.panel?.version ?? null;
  run(
    `UPDATE nodes SET last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       last_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), last_status = 'online', last_error = NULL,
       daemon_version = ?, api_version = ?, stats_json = ?, meta = ?
     WHERE id = ?`,
    [
      version,
      Number(payload?.apiVersion ?? 0),
      JSON.stringify({ ...payload?.stats, servers: payload?.servers, latencyMs, panel: payload?.panel, node: payload?.node }),
      JSON.stringify({ nodeServers: payload?.servers ?? null }),
      node.id,
    ],
  );
  return {
    ok: true, version, apiVersion: Number(payload?.apiVersion ?? 0),
    fingerprint: payload?.node?.fingerprint ?? null, stats: payload?.stats ?? null,
    servers: payload?.servers ?? null, error: null, latencyMs,
  };
}

export function markNodeDown(node: NodeRow, message: string): void {
  run(
    `UPDATE nodes SET last_status = 'offline', last_error = ?, last_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    [message.slice(0, 400), node.id],
  );
}

export function nodeIsOnline(node: NodeRow): boolean {
  if (node.is_local === 1) return true;
  if (node.last_status === "offline") return false;
  if (!node.last_heartbeat_at) return false;
  // A heartbeat older than 90 s is stale: the controller would have refreshed it every 15 s.
  const age = Date.now() - Date.parse(node.last_heartbeat_at);
  return Number.isFinite(age) && age < 90_000;
}

/* ---------------------------- Server links --------------------------------- */

export interface ServerLink {
  id: number;
  server_id: number;
  node_id: number;
  remote_server_id: number;
  remote_uuid: string | null;
}

export function linkForServer(serverId: number): ServerLink | null {
  return queryOne<ServerLink>("SELECT * FROM node_server_links WHERE server_id = ?", [serverId]);
}

export function createLink(serverId: number, nodeId: number, remoteServerId: number, remoteUuid: string | null): void {
  insert(
    `INSERT INTO node_server_links (server_id, node_id, remote_server_id, remote_uuid) VALUES (?, ?, ?, ?)
     ON CONFLICT(server_id) DO UPDATE SET node_id = excluded.node_id,
       remote_server_id = excluded.remote_server_id, remote_uuid = excluded.remote_uuid`,
    [serverId, nodeId, remoteServerId, remoteUuid],
  );
}

export function dropLink(serverId: number): void {
  run("DELETE FROM node_server_links WHERE server_id = ?", [serverId]);
}

/**
 * Rewrites a controller path (`/api/servers/12/files/list`) into the node's own path for that
 * server (`/api/servers/3/files/list`). Returns null when the node does not host this server.
 */
/** The node's own server id for a controller server id (null when the server is local). */
export function remoteLinkRemoteId(serverId: number): number | null {
  const link = linkForServer(serverId);
  if (!link) return null;
  const node = getNode(link.node_id);
  if (!node || node.is_local === 1) return null;
  return link.remote_server_id;
}

export function rewriteForNode(serverId: number, pathname: string): { node: NodeRow; path: string; remoteId: number } | null {
  const link = linkForServer(serverId);
  if (!link) return null;
  const node = getNode(link.node_id);
  if (!node || node.is_local === 1) return null;
  const prefix = `/api/servers/${serverId}`;
  if (!pathname.startsWith(prefix)) return null;
  return { node, path: `/api/servers/${link.remote_server_id}${pathname.slice(prefix.length)}`, remoteId: link.remote_server_id };
}

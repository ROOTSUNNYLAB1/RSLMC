import { Router, json, validate, v, badRequest, notFound, ApiException } from "../shared/http";
import { requirePermission } from "../auth";
import { query, queryOne, run } from "../database";
import { probeNode, getNode, nodeRequestOrThrow, nodeIsOnline, type NodeRow } from "../nodes/client";
import { nodeSelfState, setAgentKey, clearAgentKey, handshakePayload, nodeServerInventory, NODE_API_VERSION, recordAgentEvent } from "../nodes/agent";
import { recordAudit } from "../services/audit";

/**
 * Node management: the controller side (register, test, rotate, remove) and the node side
 * ("this panel is a node of …").
 *
 * Both live in the same codebase because both are the same installation — a panel becomes a node the
 * moment it is given an agent key. That is what makes a second machine usable without packaging and
 * shipping a separate daemon build that can drift from the panel.
 */

export function publicNode(node: NodeRow) {
  return {
    id: node.id,
    uuid: node.uuid,
    name: node.name,
    description: node.description,
    fqdn: node.fqdn,
    scheme: node.scheme,
    port: node.port,
    location: node.location,
    isLocal: node.is_local === 1,
    public: node.public === 1,
    maintenance: node.maintenance === 1,
    daemonVersion: node.daemon_version,
    apiVersion: node.api_version,
    lastHeartbeatAt: node.last_heartbeat_at,
    lastCheckedAt: node.last_checked_at,
    lastStatus: node.last_status,
    lastError: node.last_error,
    stats: node.stats_json ? safeJson(node.stats_json) : null,
    online: nodeIsOnline(node),
    // Never the key itself — only whether one is stored, so the UI can offer "rotate".
    hasKey: Boolean(node.agent_key),
    serverCount: queryOne<{ c: number }>("SELECT COUNT(*) AS c FROM servers WHERE node_id = ?", [node.id])?.c ?? 0,
    // Servers this controller has linked to that node (their remote ids).
    linkedServers: query<{ server_id: number }>("SELECT server_id FROM node_server_links WHERE node_id = ?", [node.id]).length,
  };
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

export function registerNodeRoutes(router: Router): void {
  /* ----------------------------- Controller side ------------------------------ */

  router.get("/api/nodes/:id", async (ctx) => {
    requirePermission(ctx.user, "node.view");
    const node = getNode(Number(ctx.params.id));
    if (!node) throw notFound("Node not found");
    return json({ node: publicNode(node) });
  });

  /** Live health check from the Nodes page ("Test connection"). */
  router.post("/api/nodes/:id/test", async (ctx) => {
    requirePermission(ctx.user, "node.manage");
    const node = getNode(Number(ctx.params.id));
    if (!node) throw notFound("Node not found");
    if (node.is_local === 1) {
      return json({ ok: true, local: true, node: publicNode(node), message: "This is the local node — it runs inside this panel." });
    }
    const result = await probeNode(node);
    const refreshed = getNode(node.id)!;
    recordAudit({
      actorId: ctx.user!.id, actorName: ctx.user!.username, action: "node.tested", ip: ctx.clientIp,
      targetType: "node", targetId: node.id, metadata: { ok: result.ok, latencyMs: result.latencyMs },
    });
    return json({
      ok: result.ok,
      latencyMs: result.latencyMs,
      version: result.version,
      apiVersion: result.apiVersion,
      error: result.error,
      node: publicNode(refreshed),
      message: result.ok
        ? `Node answered in ${result.latencyMs} ms — RSLMC ${result.version ?? "unknown"}.`
        : result.error,
    }, { status: result.ok ? 200 : 409 });
  });

  /** Rotating the key on the controller side: the new key must be pasted into the node before use. */
  router.post("/api/nodes/:id/key", async (ctx) => {
    requirePermission(ctx.user, "node.manage");
    const node = getNode(Number(ctx.params.id));
    if (!node) throw notFound("Node not found");
    if (node.is_local === 1) throw badRequest("The local node has no agent key.");
    const body = await ctx.body<{ key?: string }>();
    const key = (body.key ?? "").trim();
    if (key.length < 24) throw badRequest("Paste the full agent key from the node (at least 24 characters).");
    run("UPDATE nodes SET agent_key = ?, last_status = NULL, last_error = NULL WHERE id = ?", [key, node.id]);
    const result = await probeNode(getNode(node.id)!);
    recordAudit({
      actorId: ctx.user!.id, actorName: ctx.user!.username, action: "node.key.updated", ip: ctx.clientIp,
      targetType: "node", targetId: node.id,
    });
    return json({ ok: result.ok, node: publicNode(getNode(node.id)!), message: result.ok ? "Key accepted — node is online." : result.error });
  });

  /** Everything the node reports about itself, fetched fresh (used by the node detail panel). */
  router.get("/api/nodes/:id/inventory", async (ctx) => {
    requirePermission(ctx.user, "node.view");
    const node = getNode(Number(ctx.params.id));
    if (!node) throw notFound("Node not found");
    if (node.is_local === 1) {
      const rows = query<{ id: number; uuid: string; name: string; status: string }>(
        "SELECT id, uuid, name, status FROM servers ORDER BY id",
      );
      return json({ data: rows, local: true });
    }
    const response = await nodeRequestOrThrow(node, "/api/agent/servers");
    return json({ data: (response.body as any)?.data ?? [], local: false });
  });

  /* -------------------------------- Node side --------------------------------- */

  /** What this panel knows about its own node role (shown on the Nodes page). */
  router.get("/api/nodes/self", async (ctx) => {
    requirePermission(ctx.user, "node.view");
    return json({ self: nodeSelfState(), apiVersion: NODE_API_VERSION });
  });

  /**
   * Paste a controller's agent key into this panel. After this, the controller can drive this machine.
   * A verification handshake runs immediately so a typo is reported here instead of on the controller.
   */
  router.post("/api/nodes/self/key", async (ctx) => {
    requirePermission(ctx.user, "node.manage");
    const body = await ctx.body<{ key?: string; controllerLabel?: string; controllerUrl?: string }>();
    const key = (body.key ?? "").trim();
    if (key.length < 24) throw badRequest("That key looks too short. Copy the whole token from the controller.");
    setAgentKey(key, body.controllerLabel ?? body.controllerUrl ?? null);
    recordAudit({
      actorId: ctx.user!.id, actorName: ctx.user!.username, action: "node.self.key_set", ip: ctx.clientIp,
      metadata: { controller: body.controllerUrl ?? null },
    });
    recordAgentEvent("key.set.via_ui", body.controllerUrl ?? null);

    /*
     * The node cannot prove anything to the controller on its own: the controller is the side that
     * holds the matching copy of the key and the one that starts every conversation. So saving a key
     * here only stores it — the controller's "Test connection" button is what confirms the pair, and
     * the UI says exactly that instead of showing a green tick it has not earned.
     */
    const verified: boolean | null = null;
    const verifyError: string | null = null;
    return json({ self: nodeSelfState(), verified, verifyError });
  });

  router.delete("/api/nodes/self/key", async (ctx) => {
    requirePermission(ctx.user, "node.manage");
    clearAgentKey();
    recordAudit({ actorId: ctx.user!.id, actorName: ctx.user!.username, action: "node.self.key_cleared", ip: ctx.clientIp });
    return json({ self: nodeSelfState() });
  });

  /* ------------------------------ Agent surface ------------------------------- */

  /*
   * `/api/agent/*` is what a controller calls. Authorisation is the bearer key (handled before the
   * session check in api/index.ts, which is the only place a request can become a "node controller"
   * request). These handlers therefore never see a user session and must not assume one.
   */
  router.get("/api/agent/handshake", async () => json(handshakePayload()));

  router.get("/api/agent/servers", async () => json({ data: nodeServerInventory() }));

  /**
   * The controller proves it holds the key and the node records which controller it belongs to.
   * Used when the key is pasted on the node side, so both ends agree before any server is created.
   */
  router.post("/api/agent/verify", async (ctx) => {
    const body = await ctx.body<{ fingerprint?: string; controller?: string }>();
    recordAgentEvent("controller.verified", body.fingerprint ?? null);
    return json({ ok: true, node: nodeSelfState(), fingerprint: body.fingerprint ?? null });
  });
}

export function assertNoSelfLoop(node: NodeRow, controllerPort: number): void {
  const url = `${node.scheme}://${node.fqdn}:${node.port}`;
  if (node.port === controllerPort && ["127.0.0.1", "localhost", "::1"].includes(node.fqdn)) {
    throw new ApiException(
      400, "node_self_loop",
      `That address (${url}) is this panel. Register the node's real hostname or IP, or use a different port.`,
    );
  }
}

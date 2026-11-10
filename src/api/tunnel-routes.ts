import { Router, json, badRequest, notFound, forbidden, ApiException } from "../shared/http";
import { requirePermission } from "../auth";
import { queryOne, run } from "../database";
import { APP_VERSION } from "../shared/config";
import { getNode, nodeRequestOrThrow, nodeIsOnline, type NodeRow } from "../nodes/client";
import { recordAudit } from "../services/audit";
import { cloudflaredInfo, installCloudflared } from "../tunnels/cloudflared";
import {
  checkPublicReachability, deleteTunnel, getTunnelRow, saveTunnelConfig, startTunnel, stopTunnel,
  tunnelSnapshot, validateHostname, type TunnelConfigInput,
} from "../tunnels/manager";

/*
 * Cloudflare Tunnel routes.
 *
 * Three surfaces, because a tunnel is configured on the machine that owns the node but started from
 * wherever the operator happens to be looking:
 *
 *   1. `/api/nodes/:id/tunnel*` — what the admin UI calls. On the local node the work happens in this
 *      process; on a remote node the controller forwards the same request to that node's agent API, so
 *      the operator configures the tunnel on the machine that will run it, not on the controller.
 *   2. `/api/agent/tunnel*` — the node side of that forwarding. Bearer-key only.
 *   3. `/api/tunnels/cloudflared*` — the binary itself (present? which version? install it).
 *
 * None of these ever return a tunnel token: the UI gets `hasToken` and a fingerprint.
 */

function nodeOrThrow(idRaw: string | undefined): NodeRow {
  const node = getNode(Number(idRaw));
  if (!node) throw notFound("Node not found");
  return node;
}

/**
 * Remember what the node just told the controller about its tunnel.
 *
 * The point is the bad day: the address stops working (a quick hostname changed, DNS moved, the tunnel
 * died) and the node can no longer be asked. Without this cache, "use the tunnel address" — the button
 * you press exactly then — would have nothing to offer.
 */
function cacheTunnel(nodeId: number, tunnel: { hostname?: string | null; mode?: string | null; status?: string | null } | null | undefined): void {
  if (!tunnel) return;
  run(
    `UPDATE nodes SET tunnel_hostname = ?, tunnel_mode = ?, tunnel_status = ?, tunnel_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    [tunnel.hostname ?? null, tunnel.mode ?? null, tunnel.status ?? null, nodeId],
  );
}

function isController(user: { id: number } | undefined): boolean {
  return Boolean(user && user.id === 0);
}

/** A remote node's tunnel is managed there; this forwards and surfaces that node's answer. */
async function remoteTunnelCall(node: NodeRow, path: string, method: "GET" | "POST" | "PUT" | "DELETE" = "GET", body?: unknown) {
  // `body` is JSON-encoded by nodeRequest itself; passing a string here would double-encode it.
  const response = await nodeRequestOrThrow(node, path, { method, body });
  return response.body as Record<string, unknown>;
}

export function registerTunnelRoutes(router: Router): void {
  /* --------------------------- cloudflared binary --------------------------- */

  router.get("/api/tunnels/cloudflared", async (ctx) => {
    requirePermission(ctx.user, "node.view");
    const info = cloudflaredInfo();
    return json({
      binary: info,
      // What a tunnel can and cannot do, stated once, here, where the operator configures one.
      limits: [
        "A tunnel removes the need to open an inbound port. It does not make the panel faster: every request goes out to Cloudflare and back.",
        "Cloudflare's free plan caps a single upload at 100 MB and a request at 100 seconds. A multi-gigabyte backup download through a tunnel will fail at that size — use the LAN address for bulk transfers.",
        "Cloudflare terminates TLS in front of the node, so Cloudflare can see the traffic in plain text at its edge. It also applies its own bot and rate limits to a trycloudflare.com hostname.",
      ],
    });
  });

  router.post("/api/tunnels/cloudflared/install", async (ctx) => {
    requirePermission(ctx.user, "system.manage");
    try {
      const result = await installCloudflared();
      recordAudit({
        actorId: ctx.user!.id, actorName: ctx.user!.username, action: "cloudflared.installed", ip: ctx.clientIp,
        metadata: { version: result.version, path: result.path },
      });
      return json({ binary: cloudflaredInfo(), installed: result });
    } catch (error) {
      throw new ApiException(502, "cloudflared_install_failed", error instanceof Error ? error.message : String(error));
    }
  });

  /* --------------------------- per-node tunnel (UI) -------------------------- */

  router.get("/api/nodes/:id/tunnel", async (ctx) => {
    requirePermission(ctx.user, "node.view");
    const node = nodeOrThrow(ctx.params.id);
    if (node.is_local === 1) return json({ tunnel: tunnelSnapshot(node.id), local: true });
    try {
      const remote = await remoteTunnelCall(node, "/api/agent/tunnel");
      cacheTunnel(node.id, remote.tunnel as any);
      return json({ tunnel: remote.tunnel, local: false });
    } catch (error) {
      /*
       * A node that cannot be reached cannot tell us whether it has a tunnel right now — but the last
       * answer it gave is still worth showing, because that is the address that just stopped working.
       * Both facts are returned: `tunnel: null` (nothing live) and `cached` (the last known state).
       */
      const cached = node.tunnel_hostname
        ? { hostname: node.tunnel_hostname, mode: node.tunnel_mode, status: node.tunnel_status, seenAt: node.tunnel_seen_at }
        : null;
      return json({
        tunnel: null,
        cached,
        unreachable: `${node.name} did not answer: ${error instanceof Error ? error.message : String(error)}. A tunnel is configured on that machine — open its own panel (Admin → Nodes) if this address cannot reach it.`,
        local: false,
      });
    }
  });

  router.put("/api/nodes/:id/tunnel", async (ctx) => {
    requirePermission(ctx.user, "node.manage");
    const node = nodeOrThrow(ctx.params.id);
    const body = await ctx.body<TunnelConfigInput>();
    if (!body || (body.mode !== "token" && body.mode !== "quick")) throw badRequest("Choose a mode: token (your domain) or quick (temporary hostname).");
    if (body.mode === "token") {
      // The domain is the whole point of token mode; quick mode is the one without one.
      const existing = node.is_local === 1 ? getTunnelRow(node.id) : null;
      if (!existing?.hostname && !String(body.hostname ?? "").trim()) {
        throw badRequest("Token mode needs the public hostname you created in Cloudflare, e.g. node1.example.com.");
      }
    }
    if (node.is_local === 1) {
      const row = saveTunnelConfig(node.id, body);
      recordAudit({
        actorId: ctx.user!.id, actorName: ctx.user!.username, action: "tunnel.configured", ip: ctx.clientIp,
        targetType: "node", targetId: node.id, metadata: { mode: row.mode, hostname: row.hostname },
      });
      return json({ tunnel: tunnelSnapshot(node.id), local: true });
    }
    const remote = await remoteTunnelCall(node, "/api/agent/tunnel", "PUT", body);
    cacheTunnel(node.id, remote.tunnel as any);
    recordAudit({
      actorId: ctx.user!.id, actorName: ctx.user!.username, action: "tunnel.configured", ip: ctx.clientIp,
      targetType: "node", targetId: node.id, metadata: { mode: body.mode, hostname: body.hostname ?? null, forwarded: true },
    });
    return json({ tunnel: remote.tunnel, local: false });
  });

  router.post("/api/nodes/:id/tunnel/start", async (ctx) => {
    requirePermission(ctx.user, "node.manage");
    const node = nodeOrThrow(ctx.params.id);
    if (node.is_local === 1) {
      const snapshot = startTunnel(node.id);
      recordAudit({ actorId: ctx.user!.id, actorName: ctx.user!.username, action: "tunnel.started", ip: ctx.clientIp, targetType: "node", targetId: node.id });
      return json({ tunnel: snapshot, local: true });
    }
    const remote = await remoteTunnelCall(node, "/api/agent/tunnel/start", "POST");
    cacheTunnel(node.id, remote.tunnel as any);
    return json({ tunnel: remote.tunnel, local: false });
  });

  router.post("/api/nodes/:id/tunnel/stop", async (ctx) => {
    requirePermission(ctx.user, "node.manage");
    const node = nodeOrThrow(ctx.params.id);
    if (node.is_local === 1) {
      const snapshot = stopTunnel(node.id);
      recordAudit({ actorId: ctx.user!.id, actorName: ctx.user!.username, action: "tunnel.stopped", ip: ctx.clientIp, targetType: "node", targetId: node.id });
      return json({ tunnel: snapshot, local: true });
    }
    const remote = await remoteTunnelCall(node, "/api/agent/tunnel/stop", "POST");
    cacheTunnel(node.id, remote.tunnel as any);
    return json({ tunnel: remote.tunnel, local: false });
  });

  router.delete("/api/nodes/:id/tunnel", async (ctx) => {
    requirePermission(ctx.user, "node.manage");
    const node = nodeOrThrow(ctx.params.id);
    if (node.is_local === 1) deleteTunnel(node.id);
    else await remoteTunnelCall(node, "/api/agent/tunnel", "DELETE");
    recordAudit({ actorId: ctx.user!.id, actorName: ctx.user!.username, action: "tunnel.removed", ip: ctx.clientIp, targetType: "node", targetId: node.id });
    return json({ ok: true });
  });

  /**
   * Ask the published hostname whether it really reaches this panel.
   *
   * A separate action from "start", because they answer different questions: cloudflared can be
   * running while DNS still points elsewhere, and the operator should see which of the two is failing.
   */
  router.post("/api/nodes/:id/tunnel/check", async (ctx) => {
    requirePermission(ctx.user, "node.manage");
    const node = nodeOrThrow(ctx.params.id);
    const snapshot = node.is_local === 1
      ? tunnelSnapshot(node.id)
      : (await remoteTunnelCall(node, "/api/agent/tunnel")).tunnel as { hostname: string | null };
    if (!snapshot?.hostname) {
      throw new ApiException(409, "tunnel_no_hostname",
        "This tunnel has no hostname yet. In quick mode it appears a few seconds after the first start; in token mode enter the public hostname you created in Cloudflare.");
    }
    const result = await checkPublicReachability(snapshot.hostname);
    return json({ hostname: snapshot.hostname, ...result });
  });

  /**
   * Point the controller's own node address at the tunnel.
   *
   * The whole reason to run a tunnel on a node is so the controller can reach it at a hostname; making
   * the operator retype that hostname into the address fields would be busywork that produces typos.
   * Port 443 is used because Cloudflare serves https.
   */
  router.post("/api/nodes/:id/tunnel/use-address", async (ctx) => {
    requirePermission(ctx.user, "node.manage");
    const node = nodeOrThrow(ctx.params.id);
    if (node.is_local === 1) {
      throw badRequest("This is the local node — it runs inside this panel, so it has no address to configure.");
    }
    let tunnel: { hostname: string | null; mode: string } | undefined;
    let fromCache = false;
    try {
      const snapshot = await remoteTunnelCall(node, "/api/agent/tunnel");
      tunnel = snapshot.tunnel as { hostname: string | null; mode: string } | undefined;
      cacheTunnel(node.id, tunnel);
    } catch {
      /*
       * Unreachable is the interesting case: the address is broken, which is precisely why the operator
       * wants to point it at the tunnel. Fall back to the last state this node reported.
       */
      if (node.tunnel_hostname) {
        tunnel = { hostname: node.tunnel_hostname, mode: node.tunnel_mode ?? "token" };
        fromCache = true;
      }
    }
    // A quick tunnel's hostname is Cloudflare's answer, not something the operator typed, so the
    // "that domain is not yours" rule does not apply to it.
    const { hostname, error } = validateHostname(tunnel?.hostname ?? null, { allowQuick: tunnel?.mode === "quick" });
    if (error) throw badRequest(error);
    if (!hostname) {
      throw new ApiException(409, "tunnel_no_hostname",
        "This controller has not seen a tunnel hostname for that node yet. Open the node's own panel once the tunnel is running, or set the address by hand.");
    }
    run("UPDATE nodes SET scheme = 'https', fqdn = ?, port = 443, last_status = NULL, last_error = NULL WHERE id = ?", [hostname, node.id]);
    recordAudit({
      actorId: ctx.user!.id, actorName: ctx.user!.username, action: "node.address.tunnel", ip: ctx.clientIp,
      targetType: "node", targetId: node.id, metadata: { hostname },
    });
    return json({
      ok: true, hostname,
      /*
       * Say where the hostname came from. A cached one can be stale — a quick tunnel changes name on
       * every start — and an operator who is told "this is the last address it reported" can decide,
       * while one who is told nothing assumes the panel verified something it could not reach.
       */
      message: fromCache
        ? `${node.name} is now set to https://${hostname} — the last address it reported (${node.tunnel_seen_at ?? "unknown time"}), because the node cannot be reached right now. If that tunnel uses a temporary trycloudflare hostname it will have changed; start it and set the address again.`
        : tunnel?.mode === "quick"
          ? `${node.name} now uses https://${hostname}. Careful: a trycloudflare hostname changes every time that tunnel restarts, so this address will stop working then.`
          : `${node.name} now uses https://${hostname} (port 443, through its tunnel). Press Test to confirm it answers there.`,
      fromCache,
      online: nodeIsOnline(getNode(node.id)!),
    });
  });

  /* ---------------------- agent surface (node side) ------------------------- */

  router.get("/api/agent/ping", async () => {
    /*
     * Deliberately unauthenticated and deliberately tiny: it is the one thing that can be asked through
     * a fresh tunnel to prove the tunnel works before any key is in place. It reveals the product name
     * and nothing else — no version, no hostname, no counts.
     */
    return json({ ok: true, product: "RSLMC", panel: true });
  });

  router.get("/api/agent/tunnel", async (ctx) => {
    if (!isController(ctx.user)) throw forbidden("This endpoint is for a registered node controller.");
    return json({ tunnel: tunnelSnapshot(localNodeId()) });
  });

  router.put("/api/agent/tunnel", async (ctx) => {
    if (!isController(ctx.user)) throw forbidden("This endpoint is for a registered node controller.");
    const body = await ctx.body<TunnelConfigInput>();
    if (!body || (body.mode !== "token" && body.mode !== "quick")) throw badRequest("Choose a mode: token or quick.");
    saveTunnelConfig(localNodeId(), body);
    return json({ tunnel: tunnelSnapshot(localNodeId()) });
  });

  router.post("/api/agent/tunnel/start", async (ctx) => {
    if (!isController(ctx.user)) throw forbidden("This endpoint is for a registered node controller.");
    return json({ tunnel: startTunnel(localNodeId()) });
  });

  router.post("/api/agent/tunnel/stop", async (ctx) => {
    if (!isController(ctx.user)) throw forbidden("This endpoint is for a registered node controller.");
    return json({ tunnel: stopTunnel(localNodeId()) });
  });

  router.delete("/api/agent/tunnel", async (ctx) => {
    if (!isController(ctx.user)) throw forbidden("This endpoint is for a registered node controller.");
    deleteTunnel(localNodeId());
    return json({ ok: true });
  });

  router.post("/api/agent/tunnel/check", async (ctx) => {
    if (!isController(ctx.user)) throw forbidden("This endpoint is for a registered node controller.");
    const snapshot = tunnelSnapshot(localNodeId());
    if (!snapshot.hostname) throw new ApiException(409, "tunnel_no_hostname", "This tunnel has no hostname yet.");
    const result = await checkPublicReachability(snapshot.hostname);
    return json({ hostname: snapshot.hostname, ...result });
  });

  /* A tiny build stamp for the About page's tunnel row. */
  router.get("/api/agent/version", async () => json({ version: APP_VERSION }));
}

/** The id of the node row that represents this machine. */
function localNodeId(): number {
  const row = queryOne<{ id: number }>("SELECT id FROM nodes WHERE is_local = 1");
  if (!row) throw new ApiException(500, "local_node_missing", "This panel has no local node row.");
  return row.id;
}

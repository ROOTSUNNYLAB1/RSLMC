import type { ServerWebSocket } from "bun";
import { SESSION_COOKIE, validateSession, canAccessServer, hasPermission } from "../auth";
import { parseCookies } from "../shared/http";
import { bus, serverTopic, userTopic } from "../events/bus";
import { consoleHistory, runtimeState, currentMetrics, isRunning, publishPlayers } from "../processes/manager";
import { queryOne } from "../database";
import { rewriteForNode, nodeBaseUrl, remoteLinkRemoteId } from "../nodes/client";
import { isAgentKey, nodeControllerUser } from "../nodes/agent";
import { checkOrigin } from "../security/origin";
import type { WsMessage } from "../shared/types";

interface WsData {
  userId: number;
  isRoot: boolean;
  permissions: string[];
  serverId: number | null;
  unsubscribers: (() => void)[];
  alive: boolean;
  /** The session cookie this socket was opened with, so it can be re-checked while it stays open. */
  sessionToken: string | null;
}

type Socket = ServerWebSocket<WsData>;

const sockets = new Set<Socket>();

export function upgradeWebSocket(req: Request, server: any, url: URL): Response | undefined {
  /*
   * Two ways in: an operator's session cookie, or a controller panel's agent key. The second is how a
   * console on a remote node reaches this panel — the key is checked exactly as it is for HTTP
   * requests, and a node with no key configured still refuses everything.
   */
  const bearer = /^Bearer\s+(.+)$/i.exec((req.headers.get("authorization") ?? "").trim())?.[1]?.trim() ?? null;
  if (bearer && isAgentKey(bearer)) {
    const serverIdParam = url.searchParams.get("serverId");
    const serverId = serverIdParam ? Number(serverIdParam) : null;
    const controller = nodeControllerUser();
    const data: WsData = {
      userId: controller.id,
      isRoot: true,
      permissions: controller.permissions,
      serverId: Number.isFinite(serverId) ? serverId : null,
      unsubscribers: [],
      alive: true,
      sessionToken: null,
    };
    const upgraded = server.upgrade(req, { data });
    if (!upgraded) return new Response("WebSocket upgrade failed", { status: 400 });
    return undefined;
  }

  /*
   * Same origin rule as the HTTP API. `SameSite=Lax` already stops a cross-site page from opening an
   * authenticated socket today; this is the second lock, and it costs one header comparison.
   */
  const originDecision = checkOrigin({
    origin: req.headers.get("origin"),
    url,
    headers: req.headers,
    publicUrl: process.env.RSLMC_PUBLIC_URL ?? null,
  });
  if (!originDecision.allowed) return new Response("Forbidden", { status: 403 });

  const cookies = parseCookies(req.headers.get("cookie"));
  const token = cookies[SESSION_COOKIE];
  if (!token) return new Response("Unauthorized", { status: 401 });
  const session = validateSession(token);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const serverIdParam = url.searchParams.get("serverId");
  const serverId = serverIdParam ? Number(serverIdParam) : null;
  if (serverId && !canAccessServer(session.user, serverId)) {
    return new Response("Forbidden", { status: 403 });
  }

  const data: WsData = {
    userId: session.user.id,
    isRoot: session.user.isRoot,
    permissions: session.user.permissions,
    serverId,
    unsubscribers: [],
    alive: true,
    sessionToken: token,
  };
  const upgraded = server.upgrade(req, { data });
  if (!upgraded) return new Response("WebSocket upgrade failed", { status: 400 });
  return undefined;
}

export const websocketHandlers = {
  open(socket: Socket) {
    sockets.add(socket);
    const data = socket.data;
    socket.send(JSON.stringify({ type: "pong" } satisfies WsMessage));

    // Notifications for this user (+ admin-wide notifications).
    data.unsubscribers.push(
      bus.subscribe(userTopic(data.userId), (message) => safeSend(socket, message)),
    );

    if (data.serverId) {
      const id = data.serverId;
      /*
       * A server on another node: this socket is bridged to the node's own console socket. The panel
       * still owns the permission check (done above, on upgrade) and the node sees only its bearer
       * key, so the operator's session never leaves this machine.
       */
      const remote = rewriteForNode(id, `/api/servers/${id}`);
      if (remote) {
        bridgeRemoteConsole(socket, id, remote.node, remoteLinkRemoteId(id) ?? 0);
        return;
      }
      data.unsubscribers.push(
        bus.subscribe(serverTopic(id), (message) => safeSend(socket, message)),
      );
      socket.send(JSON.stringify({ type: "console.history", serverId: id, lines: consoleHistory(id).slice(-500) } satisfies WsMessage));
      const state = runtimeState(id);
      socket.send(JSON.stringify({
        type: "status", serverId: id, status: state.status,
        uptimeSeconds: state.startedAt ? Math.floor((Date.now() - state.startedAt) / 1000) : 0,
      } satisfies WsMessage));
      socket.send(JSON.stringify({ type: "metrics", serverId: id, metrics: currentMetrics(id) } satisfies WsMessage));
      if (isRunning(id)) publishPlayers(id);
    }
  },

  message(socket: Socket, raw: string | Buffer) {
    if (String(raw).length > 8192) {                          // console input is tiny; ignore the rest
      try { socket.close(1009, "message too large"); } catch { /* ignore */ }
      return;
    }
    if (!revalidate(socket)) return;
    const bridged = remoteBridges.get(socket);
    if (bridged) {
      bridged(String(raw));
      return;
    }
    let payload: any;
    try {
      payload = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (payload?.type === "ping") {
      socket.data.alive = true;
      safeSend(socket, { type: "pong" });
      return;
    }
    if (payload?.type === "subscribe" && payload.serverId) {
      const serverId = Number(payload.serverId);
      // Re-validate access on every subscribe: permissions can change while connected.
      const user = { id: socket.data.userId, isRoot: socket.data.isRoot, permissions: socket.data.permissions } as any;
      if (!canAccessServer(user, serverId)) {
        safeSend(socket, { type: "error", message: "You do not have access to that server" });
        return;
      }
      if (socket.data.serverId) {
        for (const unsubscribe of socket.data.unsubscribers) unsubscribe();
        socket.data.unsubscribers = [];
      }
      socket.data.serverId = serverId;
      socket.data.unsubscribers.push(bus.subscribe(serverTopic(serverId), (message) => safeSend(socket, message)));
      safeSend(socket, { type: "console.history", serverId, lines: consoleHistory(serverId).slice(-500) });
    }
  },

  close(socket: Socket) {
    sockets.delete(socket);
    for (const unsubscribe of socket.data.unsubscribers) unsubscribe();
  },

  drain(socket: Socket) {
    // Backpressure: pause delivery when the client cannot keep up.
    socket.data.alive = false;
  },
};

/*
 * A live socket kept the permissions it was opened with. HTTP is revoked the moment a role changes or
 * an account is disabled, but a disabled account could sit on an open console indefinitely and keep
 * receiving output (and its stale permissions were reused by `subscribe`). The session is re-checked
 * now on every inbound message and on every heartbeat; a socket whose session is gone is closed.
 */
function revalidate(socket: Socket): boolean {
  const token = socket.data.sessionToken;
  if (!token) return true;                                  // controller socket: bearer-authenticated per open
  const session = validateSession(token);
  if (!session || session.user.disabled) {
    try { socket.close(4401, "session ended"); } catch { /* already closed */ }
    return false;
  }
  socket.data.permissions = session.user.permissions;
  socket.data.isRoot = session.user.isRoot;
  if (socket.data.serverId !== null && !canAccessServer(session.user, socket.data.serverId)) {
    try { socket.close(4403, "access revoked"); } catch { /* already closed */ }
    return false;
  }
  return true;
}

function safeSend(socket: Socket, message: WsMessage): void {
  try {
    if (socket.readyState === 1) socket.send(JSON.stringify(message));
  } catch {
    /* client disconnected */
  }
}

/** Heartbeat: closes sockets that stopped responding so buffers cannot grow forever. */
export function startWsHeartbeat(): void {
  setInterval(() => {
    for (const socket of sockets) {
      if (!revalidate(socket)) continue;
      if (!socket.data.alive) {
        try { socket.close(1000, "idle"); } catch { /* ignore */ }
        continue;
      }
      socket.data.alive = false;
      safeSend(socket, { type: "pong" });
    }
  }, 30_000);
}

export function wsStats(): { connections: number } {
  return { connections: sockets.size };
}


/* ------------------------------ Remote node bridge ------------------------------- */

/**
 * Connects an operator's browser socket to the console of a server that runs on another node.
 *
 * The node's socket lives at `/ws?serverId=<its own id>` and authenticates with the agent key in a
 * header — Bun's WebSocket client can send one, which a browser cannot, so the panel is the only
 * party that holds the key. Messages are passed through untouched in both directions, which is what
 * keeps the console identical to a local one (history, status, metrics, commands).
 */
function bridgeRemoteConsole(socket: Socket, serverId: number, node: any, remoteServerId: number): void {
  const url = nodeBaseUrl(node).replace(/^http/, "ws") + `/ws?serverId=${remoteServerId}`;
  let upstream: WebSocket | null = null;
  try {
    upstream = new WebSocket(url, { headers: { authorization: `Bearer ${node.agent_key ?? ""}` } } as any);
  } catch (error) {
    safeSend(socket, { type: "error", message: `Could not reach node "${node.name}": ${error instanceof Error ? error.message : String(error)}` });
    return;
  }

  upstream.addEventListener("open", () => {
    socket.data.unsubscribers.push(() => {
      try { upstream?.close(1000, "panel closed"); } catch { /* already closed */ }
    });
  });
  upstream.addEventListener("message", (event) => {
    try {
      if (socket.readyState !== 1) return;
      /*
       * The node labels every message with *its* server id. The page on this side is showing the
       * controller's id, so messages are relabelled on the way through — otherwise the console
       * silently ignores history for "a different server".
       */
      let text = String((event as MessageEvent).data);
      try {
        const payload = JSON.parse(text);
        if (payload && typeof payload === "object" && "serverId" in payload) {
          payload.serverId = serverId;
          text = JSON.stringify(payload);
        }
      } catch { /* not JSON: pass it through untouched */ }
      socket.send(text);
    } catch { /* operator disconnected */ }
  });
  upstream.addEventListener("close", () => {
    safeSend(socket, { type: "error", message: `The node that runs this server closed the console connection.` });
    try { socket.close(1000, "node closed"); } catch { /* ignore */ }
  });
  upstream.addEventListener("error", () => {
    safeSend(socket, { type: "error", message: `Lost the console connection to node "${node.name}".` });
  });

  // Commands typed by the operator go upstream, not to the local process manager.
  remoteBridges.set(socket, (payload) => {
    try { upstream?.send(payload); } catch { /* upstream gone */ }
  });
}

/** Sockets currently bridged to a node, so `message()` can forward instead of handling locally. */
const remoteBridges = new WeakMap<Socket, (payload: string) => void>();

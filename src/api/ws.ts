import type { ServerWebSocket } from "bun";
import { SESSION_COOKIE, validateSession, canAccessServer, hasPermission } from "../auth";
import { parseCookies } from "../shared/http";
import { bus, serverTopic, userTopic } from "../events/bus";
import { consoleHistory, runtimeState, currentMetrics, isRunning, publishPlayers } from "../processes/manager";
import { queryOne } from "../database";
import type { WsMessage } from "../shared/types";

interface WsData {
  userId: number;
  isRoot: boolean;
  permissions: string[];
  serverId: number | null;
  unsubscribers: (() => void)[];
  alive: boolean;
}

type Socket = ServerWebSocket<WsData>;

const sockets = new Set<Socket>();

export function upgradeWebSocket(req: Request, server: any, url: URL): Response | undefined {
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

import { useEffect, useRef, useState } from "react";

export type WsMessage =
  | { type: "console"; serverId: number; lines: { ts: number; stream: string; text: string }[] }
  | { type: "console.history"; serverId: number; lines: { ts: number; stream: string; text: string }[] }
  | { type: "status"; serverId: number; status: string; uptimeSeconds: number }
  | { type: "metrics"; serverId: number; metrics: { ts: number; cpuPercent: number; memBytes: number; memCacheBytes?: number; diskBytes: number; players: number; uptimeSeconds: number } }
  | { type: "players"; serverId: number; players: { name: string; uuid: string | null; joinedAt: number | null; sessionSeconds: number | null; operator: boolean; whitelisted: boolean }[] }
  | { type: "notification"; notification: any }
  | { type: "progress"; kind: string; id: string; progress: number; total: number; label: string; done: boolean; error?: string }
  | { type: "pong" }
  | { type: "error"; message: string };

type Listener = (message: WsMessage) => void;

class PanelSocket {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private serverId: number | null = null;
  private subscribedTo: number | null | undefined = undefined;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  state: "connecting" | "open" | "closed" = "closed";
  private stateListeners = new Set<(state: PanelSocket["state"]) => void>();

  connect(serverId: number | null): void {
    this.serverId = serverId;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      // Do not re-subscribe on every page mount: a duplicate subscribe replays the
      // console history and looks like the page reloading itself.
      if (this.socket.readyState === WebSocket.OPEN && this.subscribedTo !== serverId) {
        this.subscribedTo = serverId;
        this.socket.send(JSON.stringify({ type: "subscribe", serverId }));
      }
      return;
    }
    this.open();
  }

  private open(): void {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const query = this.serverId ? `?serverId=${this.serverId}` : "";
    this.setState("connecting");
    try {
      this.socket = new WebSocket(`${protocol}://${window.location.host}/ws${query}`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket.onopen = () => {
      this.setState("open");
      this.reconnectAttempts = 0;
      this.subscribedTo = this.serverId;
      this.heartbeat = setInterval(() => {
        try { this.socket?.send(JSON.stringify({ type: "ping" })); } catch { /* ignore */ }
      }, 25_000);
    };
    this.socket.onmessage = (event) => {
      let parsed: WsMessage;
      try { parsed = JSON.parse(event.data as string); } catch { return; }
      if (parsed.type === "pong") return;
      for (const listener of this.listeners) listener(parsed);
    };
    this.socket.onclose = () => {
      this.setState("closed");
      this.subscribedTo = undefined;
      if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
      this.scheduleReconnect();
    };
    this.socket.onerror = () => { /* handled by onclose */ };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(15_000, 800 * Math.pow(1.7, this.reconnectAttempts++));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  subscribeServer(serverId: number | null): void {
    this.serverId = serverId;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.subscribedTo = serverId;
      this.socket.send(JSON.stringify({ type: "subscribe", serverId }));
    } else {
      this.connect(serverId);
    }
  }

  send(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onState(listener: (state: PanelSocket["state"]) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  private setState(state: PanelSocket["state"]): void {
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }

  close(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    this.socket?.close();
    this.socket = null;
  }
}

export const panelSocket = new PanelSocket();

/** Subscribes to live events for a server (or panel-wide when serverId is null). */
export function usePanelSocket(serverId: number | null, handler: (message: WsMessage) => void): "connecting" | "open" | "closed" {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const [state, setState] = useState<PanelSocket["state"]>(panelSocket.state);

  useEffect(() => panelSocket.onState(setState), []);

  useEffect(() => {
    panelSocket.connect(serverId);
    const unsubscribe = panelSocket.on((message) => handlerRef.current(message));
    return () => { unsubscribe(); };
  }, [serverId]);

  return state;
}

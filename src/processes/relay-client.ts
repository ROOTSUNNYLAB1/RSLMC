import { connect, type Socket } from "node:net";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { PATHS } from "../shared/config";

/**
 * Panel side of the server relay (see `relay.ts`). Two entry points:
 *
 *  - `startRelay()`  — spawn the detached relay and connect to it right away (normal server start).
 *  - `attachRelay()` — reconnect to a relay that outlived a previous panel process (panel restart).
 *
 * Both return the same `RelayConnection`, which behaves like a spawned process for the manager:
 * it has a pid (the JVM's), a stdin-like writer and a kill.
 */

export interface RelayLine {
  seq: number;
  ts: number;
  stream: "stdout" | "stderr" | "system";
  text: string;
}

export interface RelayState {
  serverId: number;
  uuid: string;
  port: number;
  token: string;
  relayPid: number;
  javaPid: number | null;
  startedAt: number;
  relayStartedAt: number;
  cwd: string;
  logPath: string;
  seq: number;
  exitCode?: number | null;
  exitAt?: number;
  signal?: string | null;
}

export interface RelayConnection {
  /** PID of the Minecraft JVM (not the relay). */
  pid: number | null;
  stdin: { write(chunk: string): number | void; flush(): void } | null;
  kill(signal?: string | number): void;
  /** Detach the panel from the relay *without* touching the JVM — used on panel restart. */
  disconnect(): void;
  state: RelayState;
  /** True when this connection adopted a relay that existed before the panel started. */
  adopted: boolean;
}

export interface RelayCallbacks {
  onLine: (line: RelayLine) => void;
  onExit: (code: number | null, signal: string | null) => void;
  onNotice?: (message: string) => void;
}

function relaysDir(): string {
  const dir = join(PATHS.data, "runtime", "relays");
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* exists */ }
  return dir;
}

export function relayStatePath(serverId: number): string {
  return join(relaysDir(), `${serverId}.json`);
}

export function relayLogPath(uuid: string): string {
  const dir = join(PATHS.logs, "servers");
  try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
  return join(dir, `${uuid}.log`);
}

export function readRelayState(serverId: number): RelayState | null {
  const path = relayStatePath(serverId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as RelayState;
    if (!parsed?.port || !parsed.token || !parsed.relayPid) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function forgetRelay(serverId: number): void {
  try { unlinkSync(relayStatePath(serverId)); } catch { /* already gone */ }
}

export function isRelayAlive(state: RelayState): boolean {
  try {
    process.kill(state.relayPid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Entry point of the relay child process. */
function relayEntryPath(): string {
  return join(import.meta.dir, "relay.ts");
}

function connectTo(state: RelayState, options: { since?: number; timeoutMs?: number } = {}): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ port: state.port, host: "127.0.0.1" });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`relay on port ${state.port} did not answer within ${options.timeoutMs ?? 4000} ms`));
    }, options.timeoutMs ?? 4000);
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.setEncoding("utf8");
      socket.write(`${JSON.stringify({ type: "hello", token: state.token, since: options.since ?? 0 })}\n`);
      resolve(socket);
    });
  });
}

function wire(socket: Socket, state: RelayState, callbacks: RelayCallbacks, adopted: boolean): RelayConnection {
  let buffer = "";
  let closed = false;
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      let message: any;
      try { message = JSON.parse(raw); } catch { continue; }
      switch (message?.type) {
        case "ready":
          if (typeof message.javaPid === "number") state.javaPid = message.javaPid;
          break;
        case "backlog":
          for (const line of message.lines ?? []) callbacks.onLine(line as RelayLine);
          break;
        case "out":
          if (message.line) callbacks.onLine(message.line as RelayLine);
          break;
        case "exit":
          if (closed) break;
          closed = true;
          callbacks.onExit(typeof message.code === "number" ? message.code : null, message.signal ?? null);
          break;
        case "kill-failed":
          callbacks.onNotice?.(`The relay could not terminate pid ${message.pid}; it is still running.`);
          break;
        default:
          break;
      }
    }
  });
  const finish = () => {
    if (closed) return;
    closed = true;
    // A dropped socket without an exit message means the relay itself died. The JVM's fate is
    // unknown, so report "no exit code" rather than inventing success.
    callbacks.onExit(null, "relay-disconnected");
  };
  socket.on("close", finish);
  socket.on("error", finish);

  const connection: RelayConnection = {
    pid: state.javaPid ?? null,
    stdin: {
      write(chunk: string) {
        if (socket.destroyed) return 0;
        socket.write(`${JSON.stringify({ type: "stdin", data: chunk })}\n`);
        return chunk.length;
      },
      flush() { /* the socket flushes itself */ },
    },
    kill(signal?: string | number) {
      if (socket.destroyed) {
        if (connection.pid) { try { process.kill(connection.pid, signal as any); } catch { /* gone */ } }
        return;
      }
      if (typeof signal === "string" && signal.startsWith("SIG")) {
        socket.write(`${JSON.stringify({ type: "signal", signal })}\n`);
      } else {
        socket.write(`${JSON.stringify({ type: "kill-tree" })}\n`);
      }
    },
    disconnect() {
      closed = true;
      try { socket.destroy(); } catch { /* ignore */ }
    },
    state,
    adopted,
  };
  return connection;
}

export interface StartRelayOptions extends RelayCallbacks {
  serverId: number;
  uuid: string;
  command: string[];
  cwd: string;
  env?: Record<string, string>;
}

/**
 * Spawns the relay and connects to it. Returns null when the relay could not be brought up, in
 * which case the caller falls back to the classic in-process spawn — a panel that cannot relay must
 * still be able to start servers.
 */
export async function startRelay(options: StartRelayOptions): Promise<RelayConnection | null> {
  const token = randomBytes(32).toString("hex");
  const statePath = relayStatePath(options.serverId);
  const logPath = relayLogPath(options.uuid);
  const planPath = join(relaysDir(), `${options.serverId}.plan.json`);
  const plan = {
    serverId: options.serverId,
    uuid: options.uuid,
    command: options.command,
    cwd: options.cwd,
    env: options.env ?? {},
    statePath,
    logPath,
    token,
    startedAt: Date.now(),
  };
  writeFileSync(planPath, JSON.stringify(plan, null, 2), { mode: 0o600 });

  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([process.execPath, relayEntryPath(), planPath], {
      cwd: options.cwd,
      // Detached: the relay gets its own process group, so the panel's exit (or Ctrl+C) does not
      // take the Minecraft server with it. This is what makes "Restart RSLMC" safe.
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env },
    });
  } catch {
    return null;
  }

  const deadline = Date.now() + 8000;
  let state: RelayState | null = null;
  while (Date.now() < deadline) {
    state = readRelayState(options.serverId);
    if (state && state.token === token && state.port) break;
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  if (!state || state.token !== token) {
    try { child.kill(); } catch { /* ignore */ }
    forgetRelay(options.serverId);
    try { unlinkSync(planPath); } catch { /* ignore */ }
    return null;
  }
  try {
    const socket = await connectTo(state, {});
    return wire(socket, state, options, false);
  } catch {
    try { child.kill(); } catch { /* ignore */ }
    forgetRelay(options.serverId);
    return null;
  }
}

/**
 * Reconnects to a relay left behind by a previous panel process. Returns null when there is no live
 * relay for this server (nothing to adopt) — the caller then falls back to JVM orphan detection.
 */
export async function attachRelay(serverId: number, uuid: string, callbacks: RelayCallbacks): Promise<RelayConnection | null> {
  const state = readRelayState(serverId);
  if (!state) return null;
  if (state.uuid && state.uuid !== uuid) return null;
  if (!isRelayAlive(state)) {
    forgetRelay(serverId);
    return null;
  }
  try {
    const socket = await connectTo(state, { since: 0, timeoutMs: 3500 });
    // Adopted connections ask for history so the console is not empty after a restart.
    return wire(socket, state, callbacks, true);
  } catch {
    return null;
  }
}

/** Removes the relay's leftovers once its JVM is gone. */
export function cleanRelayFiles(serverId: number): void {
  forgetRelay(serverId);
  try { rmSync(join(relaysDir(), `${serverId}.plan.json`), { force: true }); } catch { /* ignore */ }
}

/** Reads the last N console lines the relay wrote to disk (used by the console page after adoption). */
export function readRelayLog(uuid: string, limit = 400): string[] {
  const path = relayLogPath(uuid);
  if (!existsSync(path)) return [];
  try {
    const text = readFileSync(path, "utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    return lines.slice(-limit);
  } catch {
    return [];
  }
}

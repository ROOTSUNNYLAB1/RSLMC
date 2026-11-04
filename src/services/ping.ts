import { connect } from "node:net";

/*
 * "How far away is this server?"
 *
 * Minecraft shows a player their ping to the server in the multiplayer list: five bars and a number
 * in milliseconds. The panel can answer the same question honestly, but only if it is measured rather
 * than invented.
 *
 * There are two real numbers involved and they are different things:
 *
 *   1. the user → panel round trip, which only the browser can measure (it is the browser's own
 *      network path). The UI times the request itself; nothing is guessed here.
 *   2. the hosting machine → game port round trip, measured below: a real TCP handshake to the
 *      address the players connect on, timed with `performance.now()`.
 *
 * When the game port is closed (server stopped) the handshake is refused in microseconds — that is
 * not "0 ms ping", it is "nothing is listening", and the result says so instead of printing a
 * flattering number.
 */

export interface PingResult {
  /** The address that was actually dialled. */
  target: string;
  /** Handshake round trip in milliseconds, or `null` when nothing answered. */
  ms: number | null;
  /** True when the port accepted a connection (a listening socket, not necessarily a live world). */
  reachable: boolean;
  /** Why it failed: `refused`, `timeout`, `unresolved`, or `invalid`. */
  reason: "refused" | "timeout" | "unresolved" | "invalid" | null;
  /** Attempts that were made (a median of the successful ones is reported). */
  samples: number[];
}

/** The address to dial for a bind address: a wildcard bind is reached over loopback. */
export function dialHost(bindIp: string): string {
  const trimmed = (bindIp ?? "").trim();
  if (!trimmed || trimmed === "0.0.0.0") return "127.0.0.1";
  if (trimmed === "::" || trimmed === "[::]") return "::1";
  return trimmed;
}

/**
 * One TCP handshake, timed. Resolves with the round trip in milliseconds, or a reason.
 *
 * `performance.now()` is used rather than `Date.now()` because a handshake on the same machine takes
 * tens of microseconds and a millisecond wall clock cannot see it.
 */
export function tcpHandshake(
  host: string,
  port: number,
  timeoutMs = 3000,
): Promise<{ ms: number | null; reason: PingResult["reason"] }> {
  return new Promise((resolve) => {
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
      resolve({ ms: null, reason: "invalid" });
      return;
    }
    const started = performance.now();
    let settled = false;
    const socket = connect({ host, port });
    const finish = (ms: number | null, reason: PingResult["reason"]) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* already gone */ }
      resolve({ ms, reason });
    };
    const timer = setTimeout(() => finish(null, "timeout"), timeoutMs);
    socket.once("connect", () => {
      const elapsed = performance.now() - started;
      clearTimeout(timer);
      finish(elapsed, null);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ENOTFOUND" || error.code === "EAI_AGAIN") finish(null, "unresolved");
      else if (error.code === "ETIMEDOUT") finish(null, "timeout");
      else finish(null, "refused");
    });
  });
}

/** Median of the attempts that answered, rounded to one decimal. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0;
  return Math.round(value * 10) / 10;
}

/**
 * Measure the game port from the machine that hosts it.
 *
 * Three attempts, median reported: a single handshake on a busy host can be 10× its usual cost, and
 * a ping that jumps around for no reason is worse than no ping at all.
 */
export async function measureGamePort(
  bindIp: string,
  port: number,
  attempts = 3,
): Promise<PingResult> {
  const host = dialHost(bindIp);
  const target = `${host}:${port}`;
  const samples: number[] = [];
  let reason: PingResult["reason"] = null;
  for (let index = 0; index < attempts; index += 1) {
    const result = await tcpHandshake(host, port);
    if (result.ms === null) {
      reason = result.reason;
      // A refused connection will be refused again: no point burning two more timeouts.
      if (result.reason !== "timeout") break;
      continue;
    }
    samples.push(result.ms);
  }
  return {
    target,
    ms: samples.length > 0 ? median(samples) : null,
    reachable: samples.length > 0,
    reason: samples.length > 0 ? null : reason,
    samples: samples.map((value) => Math.round(value * 10) / 10),
  };
}

/**
 * Which of the five bars a round trip deserves — the same idea as Minecraft's connection icon, with
 * the thresholds a player would recognise: under 40 ms is a full bar set, 300 ms or worse is one.
 */
export function pingBars(ms: number | null): 0 | 1 | 2 | 3 | 4 | 5 {
  if (ms === null) return 0;
  if (ms <= 40) return 5;
  if (ms <= 80) return 4;
  if (ms <= 150) return 3;
  if (ms <= 300) return 2;
  return 1;
}

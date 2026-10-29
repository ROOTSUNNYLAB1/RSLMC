import { createSocket } from "node:dgram";

/** Attempts a real TCP bind to detect conflicts. Returns true when the port is usable. */
export async function isTcpPortFree(ip: string, port: number): Promise<boolean> {
  const host = ip === "0.0.0.0" || ip === "::" ? "0.0.0.0" : ip;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      try { server.stop(true); } catch { /* ignore */ }
      resolve(value);
    };
    let server: any;
    try {
      server = Bun.listen({
        hostname: host,
        port,
        socket: { data() {}, open() { finish(true); }, error() { finish(false); } },
      });
      // Bun.listen throws EADDRINUSE synchronously when busy.
      finish(true);
    } catch {
      finish(false);
    }
    setTimeout(() => finish(true), 400);
  });
}

export function isUdpPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    socket.once("error", () => { socket.close(); resolve(false); });
    socket.bind({ port, exclusive: true }, () => { socket.close(); resolve(true); });
  });
}

export function normalizeBindIp(ip: string): string {
  const trimmed = (ip ?? "").trim();
  if (!trimmed) return "0.0.0.0";
  if (["0.0.0.0", "127.0.0.1", "::", "::1"].includes(trimmed)) return trimmed;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(trimmed);
  if (ipv4) {
    if (ipv4.slice(1).every((part) => Number(part) <= 255)) return trimmed;
    throw new Error("Invalid IPv4 address");
  }
  if (/^[0-9a-fA-F:]+$/.test(trimmed) && trimmed.includes(":")) return trimmed;
  throw new Error("Invalid bind address");
}

export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** True when the address is bound to a wildcard interface (reachable from other hosts). */
export function isWildcardBind(ip: string): boolean {
  return ip === "0.0.0.0" || ip === "::";
}

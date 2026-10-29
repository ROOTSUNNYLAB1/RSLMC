/**
 * Player-facing address of a server.
 *
 * `bind_ip` / `port` describe how the JVM listens on this machine. A tunnel or port-forwarding tool
 * (playit.gg, ngrok, FRP…) gives players a different hostname — sometimes with a port, often
 * without. That is `public_host` / `public_port`, and it wins wherever an address is shown to the
 * operator or copied for sharing:
 *
 * | public_host | public_port | shown / copied        |
 * | ----------- | ----------- | --------------------- |
 * | –           | –           | `203.0.113.5:25565` (internal) |
 * | `srv.playit.gg` | –       | `srv.playit.gg`        (no port — the tunnel owns it) |
 * | `srv.playit.gg` | `25590` | `srv.playit.gg:25590`  |
 *
 * Nothing is invented: when no public host is configured the internal address is used verbatim.
 */

export interface AddressParts {
  bindIp: string;
  port: number;
  publicHost?: string | null;
  publicPort?: number | null;
}

/** Accepts `play.example.com`, `https://play.example.com/`, `play.example.com:25565`… */
export function normalisePublicHost(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  let value = String(raw).trim().toLowerCase();
  if (!value) return null;
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  value = value.replace(/\/.*$/, "");                    // path
  value = value.replace(/^\/+|\/+$/g, "");
  if (!value) return null;
  if (!/^[a-z0-9._-]+(:\d{1,5})?$/.test(value)) {
    throw new Error("Public address may only contain letters, digits, dots, dashes and underscores (optionally :port)");
  }
  /*
   * A "public" address that players cannot reach is worse than none: the panel would show it as the
   * join address and people would try to connect to it. Loopback, RFC1918, link-local (169.254.x,
   * which includes cloud metadata endpoints) and 0.0.0.0 are rejected with an explanation instead of
   * being stored. A hostname is always allowed — only IP literals are inspected, so a tunnel domain
   * that resolves to a private address still works.
   */
  const hostPart = value.replace(/:\d{1,5}$/, "");
  if (isPrivateIpLiteral(hostPart)) {
    throw new Error(
      `${hostPart} is a private or local address, so players on the internet cannot join through it. `
      + "Use your playit.gg / ngrok domain, or a public IP.",
    );
  }
  return value;
}

/** True for IPv4 literals that are not reachable from the internet (and for IPv6 loopback). */
export function isPrivateIpLiteral(host: string): boolean {
  if (host === "::1" || host === "localhost") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false; // a hostname — resolvable addresses are not our business here
  const [a, b] = [Number(match[1]), Number(match[2])];
  if ([a, b].some((part) => part > 255)) return false;
  if (a === 0 || a === 127) return true;                       // 0.0.0.0/8, loopback
  if (a === 10) return true;                                   // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true;            // RFC1918
  if (a === 192 && b === 168) return true;                     // RFC1918
  if (a === 169 && b === 254) return true;                     // link-local + cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true;           // CGNAT
  if (a >= 224) return true;                                   // multicast / reserved
  return false;
}

/** Splits an `host:port` typed into the single "public address" field. */
export function splitHostPort(value: string): { host: string; port: number | null } {
  const match = /^(.*):(\d{1,5})$/.exec(value);
  if (!match) return { host: value, port: null };
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { host: value, port: null };
  return { host: match[1]!, port };
}

export function validatePublicPort(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Public port must be between 1 and 65535");
  }
  return port;
}

export function isTunnelHost(host: string, bindIp: string): boolean {
  const value = host.trim().toLowerCase();
  if (!value) return false;
  const { host: bareHost } = splitHostPort(value);
  return bareHost !== bindIp.toLowerCase();
}

/** The address players should use. */
export function playAddress(parts: AddressParts, internalHost: string): string {
  const host = (parts.publicHost ?? "").trim();
  if (!host) return `${internalHost}:${parts.port}`;
  // A public port is only appended when the operator supplied one explicitly.
  const { host: bare, port: inlinePort } = splitHostPort(host);
  const port = parts.publicPort ?? inlinePort;
  return port ? `${bare}:${port}` : bare;
}

/** Host only (no port) — used for compact rows. */
export function playHost(parts: AddressParts, internalHost: string): string {
  const host = (parts.publicHost ?? "").trim();
  if (!host) return internalHost;
  return splitHostPort(host).host;
}

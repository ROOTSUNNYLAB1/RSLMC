import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ApiException } from "../shared/http";

/**
 * Which addresses a node may live at.
 *
 * A node address is typed in by an administrator and then re-probed every 15 seconds forever, so it
 * is a URL the panel keeps fetching on its own. That is fine for the intended case — another machine
 * on the same LAN or a public host — and wrong for the cloud metadata services, which are reachable
 * from a panel running on a VM and hand out credentials:
 *
 *   169.254.0.0/16   link-local; AWS/GCP/Azure/OpenStack metadata (169.254.169.254)
 *   100.100.100.200  Alibaba Cloud metadata
 *   fd00:ec2::254    AWS metadata over IPv6
 *
 * Loopback stays refused as a *node* address (a node is another machine), which also keeps the
 * self-loop check honest. Private ranges (10/8, 172.16/12, 192.168/16, fc00::/7) are allowed on
 * purpose: "a second panel on my LAN" is the primary multi-node use case, and an administrator who
 * can register a node can already run commands on the panel host.
 */

const METADATA_V4 = [
  /^169\.254\./,                       // link-local + AWS/GCP/Azure/OpenStack metadata
  /^100\.100\.100\.200$/,              // Alibaba Cloud
];

/*
 * Loopback is *allowed*: two panels on one machine (a container, a test deployment, a second
 * instance on another port) is a real setup, and the "points at this very panel" case is already
 * refused by `assertNoSelfLoop` (loopback + the controller's own port). Wildcard addresses are not
 * a destination at all, so those are refused here.
 */
const LITERAL_UNROUTABLE = ["0.0.0.0", "::", "[::]"];

/** Human-readable reason the address is refused, or `null` when it is acceptable. */
export function nodeAddressProblem(host: string): string | null {
  const value = host.trim().toLowerCase();
  if (!value) return "the address is empty";
  if (LITERAL_UNROUTABLE.includes(value)) return "a wildcard address is not a destination";
  const version = isIP(value);
  if (version === 4) {
    if (METADATA_V4.some((pattern) => pattern.test(value))) {
      return "cloud metadata addresses are not valid nodes";
    }
    return null;
  }
  if (version === 6) {
    const flat = value.replace(/^\[|\]$/g, "");
    if (/^fe80:/i.test(flat)) return "link-local addresses are not valid nodes";
    if (flat === "fd00:ec2::254") return "cloud metadata addresses are not valid nodes";
    return null;
  }
  // A hostname: resolved below, before the address is stored.
  return null;
}

/**
 * Resolves a hostname and applies `nodeAddressProblem` to every answer.
 * `null` means "could not resolve right now" — callers treat that as acceptable for a *stored* node
 * (its DNS may simply be down) but not for a fresh registration.
 */
export async function resolveNodeHost(host: string): Promise<{ addresses: string[]; problem: string | null }> {
  const literal = nodeAddressProblem(host);
  if (literal) return { addresses: [], problem: literal };
  if (isIP(host.replace(/^\[|\]$/g, ""))) return { addresses: [host], problem: null };
  try {
    const records = await lookup(host, { all: true, verbatim: true });
    const addresses = records.map((record) => record.address);
    for (const address of addresses) {
      const problem = nodeAddressProblem(address);
      if (problem) return { addresses, problem: `${host} resolves to ${address}: ${problem}` };
    }
    return { addresses, problem: null };
  } catch {
    return { addresses: [], problem: null };
  }
}

/** Throws unless the host may be registered as a node. */
export async function assertNodeHostAllowed(host: string): Promise<void> {
  const { problem } = await resolveNodeHost(host);
  if (problem) {
    throw new ApiException(
      400, "node_address_refused",
      `“${host}” cannot be used as a node address — ${problem}. ` +
      "Use the other machine's LAN or public address.",
    );
  }
}

/**
 * One field, however the operator thinks about it.
 *
 * Registering a second machine used to need three inputs — scheme, host, port — and the two that
 * matter are the ones people get wrong: an `https://` domain entered with port 3986, or an IP with
 * `https` because it "looked safer". A domain published through a tunnel or plain DNS is always
 * `https` on 443; a LAN machine panel is `http` on its own port. Both are recognisable, so the panel
 * recognises them and the operator types one string.
 *
 * Accepts, and normalises:
 *   node1.example.com              → https://node1.example.com:443   (a domain ⇒ TLS on 443)
 *   https://node1.example.com/     → https://node1.example.com:443
 *   node1.example.com:8443         → https://node1.example.com:8443  (explicit port wins)
 *   http://node1.example.com       → http://node1.example.com:80     (explicit scheme wins)
 *   10.0.0.4                       → http://10.0.0.4:3986            (LAN panel default)
 *   10.0.0.4:3986                  → http://10.0.0.4:3986
 *   [fd00::1]:3986                 → http://[fd00::1]:3986
 */
export interface ParsedNodeAddress {
  scheme: "http" | "https";
  fqdn: string;
  port: number;
  /** `domain` (published through DNS/tunnel), `literal` (an IP), or `unknown` when it could not be read. */
  kind: "domain" | "literal" | "unknown";
  /** True when this looks like a hostname on 443 — i.e. served by a tunnel/reverse proxy. */
  viaTls: boolean;
  /** Anything the operator should know about how the value was read. */
  note: string | null;
}

const DEFAULT_PANEL_PORT = 3986;

export function parseNodeAddress(raw: string): { parsed: ParsedNodeAddress | null; error: string | null } {
  let value = (raw ?? "").trim();
  if (!value) return { parsed: null, error: "Enter the node's domain (node1.example.com) or its LAN address (10.0.0.4:3986)." };

  let scheme: "http" | "https" | null = null;
  const schemeMatch = value.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (schemeMatch) {
    const found = schemeMatch[1].toLowerCase();
    if (found !== "http" && found !== "https") {
      return { parsed: null, error: `"${found}://" is not supported for a node — use http or https. RSLMC speaks HTTP to a node, with TLS when a tunnel or proxy provides it.` };
    }
    scheme = found;
    value = value.slice(schemeMatch[0].length);
  }
  value = value.split("/")[0].split("?")[0].split("#")[0];
  // user:pass@host is not a node address; drop it rather than storing a credential in the wrong column.
  value = value.split("@").pop() ?? value;
  if (!value) return { parsed: null, error: "That is only a scheme — add the host, e.g. https://node1.example.com." };

  let port: number | null = null;
  let host = value;
  const bracket = value.match(/^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/i);
  if (bracket) {
    host = bracket[1];
    if (bracket[2]) port = Number(bracket[2]);
  } else if (/^[^:]+:\d{1,5}$/.test(value)) {
    const index = value.lastIndexOf(":");
    host = value.slice(0, index);
    port = Number(value.slice(index + 1));
  } else if ((value.match(/:/g)?.length ?? 0) > 1) {
    // A bare IPv6 address ("fd00::1"): no port can be expressed without brackets.
    host = value;
  }

  host = host.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!host) return { parsed: null, error: "That address has no host in it." };
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    return { parsed: null, error: `Port ${port} is not a valid port (1–65535).` };
  }

  if (host === "localhost" || host.endsWith(".localhost")) {
    return { parsed: null, error: "localhost is this machine. A node is another panel — put its LAN address (10.0.0.4:3986) or its domain." };
  }
  const version = isIP(host);
  const kind: ParsedNodeAddress["kind"] = version === 4 || version === 6 ? "literal" : "domain";
  if (kind === "domain" && (!host.includes(".") || !/^[a-z0-9.-]+$/.test(host))) {
    return { parsed: null, error: `"${host}" is not a hostname. Use a domain (node1.example.com) or an IP address (10.0.0.4).` };
  }

  let note: string | null = null;
  if (scheme === null) {
    if (kind === "domain") {
      scheme = "https";
      note = "A domain is assumed to be served over HTTPS — that is what a tunnel or reverse proxy gives you.";
    } else {
      scheme = "http";
      note = "An IP address is assumed to be the panel's own port over plain HTTP.";
    }
  }
  if (port === null) {
    port = scheme === "https" ? 443 : kind === "literal" ? DEFAULT_PANEL_PORT : 80;
    if (scheme === "https" && !schemeMatch) note = note ?? "Port 443 is used for HTTPS.";
  }
  if (scheme === "https" && kind === "literal") {
    note = "An HTTPS node address must have a certificate for that name — with an IP, most tunnels and proxies will refuse. Use the domain, or http for a LAN machine.";
  }

  return {
    parsed: { scheme, fqdn: host, port, kind, viaTls: scheme === "https" && port === 443, note },
    error: null,
  };
}

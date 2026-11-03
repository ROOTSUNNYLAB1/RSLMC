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

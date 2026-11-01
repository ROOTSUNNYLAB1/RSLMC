/**
 * Same-origin check for state-changing requests.
 *
 * A CSRF token already protects every write (double submit), so this is a second lock — but a lock
 * that must not jam for people running the panel the normal way: behind nginx, Caddy, a Cloudflare
 * tunnel or a PaaS router. The old check compared full origin strings (`https://panel.example.com`
 * against `http://panel.example.com`, because the panel itself only ever sees plain HTTP from the
 * proxy), so a correctly configured reverse proxy produced `403 origin_invalid` on *every* mutation:
 * saving preferences, starting a server, anything that is not a GET. The host is what actually
 * matters for CSRF; a scheme difference behind TLS termination is the proxy doing its job.
 *
 * Rules, in order:
 *   1. A request with no Origin header is allowed (same-site form posts and curl do not send one;
 *      the CSRF token still has to be right).
 *   2. The origin's host must match one of the hosts this panel answers on: the URL host Bun saw,
 *      `x-forwarded-host`, or the operator-configured `RSLMC_PUBLIC_URL`.
 *   3. Scheme and a default port are ignored when comparing — but a different *port* is not.
 *   4. Anything else — another hostname, a lookalike subdomain, a null origin — is refused.
 */

export interface OriginInput {
  /** The Origin header, if the browser sent one. */
  origin: string | null;
  /** The URL the panel itself received (behind a proxy this is usually the internal address). */
  url: URL;
  headers: Headers;
  /** `RSLMC_PUBLIC_URL`, e.g. `https://panel.example.com`, when the operator set it. */
  publicUrl?: string | null;
}

export interface OriginDecision {
  allowed: boolean;
  /** Which configured host the origin matched, for the log line. */
  matched: string | null;
  /** Every host the panel would accept, so a rejection can explain itself. */
  considered: string[];
  reason?: "no_origin" | "matched" | "host_mismatch" | "unparsable_origin";
}

/** `host` lower-cased, with `:443` for https and `:80` for http removed; other ports kept. */
export function normaliseHost(host: string, protocol: string): string {
  const lower = host.trim().toLowerCase();
  const isHttps = protocol.replace(":", "") === "https";
  if (isHttps && lower.endsWith(":443")) return lower.slice(0, -4);
  if (!isHttps && lower.endsWith(":80")) return lower.slice(0, -3);
  return lower;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function checkOrigin(input: OriginInput): OriginDecision {
  const { origin, url, headers } = input;
  const considered = new Set<string>();

  const add = (host: string | null, protocol: string) => {
    if (host) considered.add(normaliseHost(host, protocol));
  };

  add(url.host, url.protocol);
  // A proxy that preserves the original Host tells us the public hostname directly.
  const forwardedHost = headers.get("x-forwarded-host");
  if (forwardedHost) {
    // x-forwarded-host can be a comma-separated chain; the first entry is the client-facing host.
    add(forwardedHost.split(",")[0]!, headers.get("x-forwarded-proto") ?? url.protocol);
  }
  const publicUrl = input.publicUrl ? parseUrl(input.publicUrl) : null;
  if (publicUrl) add(publicUrl.host, publicUrl.protocol);

  const list = [...considered];
  if (!origin) return { allowed: true, matched: null, considered: list, reason: "no_origin" };
  if (origin === "null") return { allowed: false, matched: null, considered: list, reason: "host_mismatch" };

  const parsed = parseUrl(origin);
  if (!parsed) return { allowed: false, matched: null, considered: list, reason: "unparsable_origin" };

  const candidate = normaliseHost(parsed.host, parsed.protocol);
  const matched = list.find((host) => host === candidate) ?? null;
  return matched
    ? { allowed: true, matched, considered: list, reason: "matched" }
    : { allowed: false, matched: null, considered: list, reason: "host_mismatch" };
}

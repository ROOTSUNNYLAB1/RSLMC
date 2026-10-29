import { Router, jsonError, json, ApiException } from "../shared/http";
import { SESSION_COOKIE, validateSession, hasPermission, canAccessServer } from "../auth";
import { rateLimit } from "../security/ratelimit";
import { buildContext } from "./context";
import { registerAuthRoutes } from "./auth-routes";
import { registerServerRoutes } from "./server-routes";
import { registerFileRoutes } from "./file-routes";
import { registerAdminRoutes } from "./admin-routes";
import type { RequestContext } from "../shared/http";
import type { Permission } from "../shared/permissions";

export const api = new Router();
registerAuthRoutes(api);
registerServerRoutes(api);
registerFileRoutes(api);
registerAdminRoutes(api);

/** Routes that are reachable without a session. */
const PUBLIC_ROUTES = new Set([
  "POST /api/auth/login",
  "POST /api/auth/register",
  "GET /api/auth/registration",
  "POST /api/auth/password/check",
  "GET /api/auth/oauth/providers",
  "POST /api/auth/oauth/complete",
  "GET /api/auth/me",
  "GET /api/setup/status",
  "GET /api/setup/enforcement",
]);

const PUBLIC_ROUTE_PATTERNS = new Set([
  "GET /api/auth/oauth/[^/]+/start",
  "GET /api/auth/oauth/[^/]+/callback",
]);

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export async function handleApiRequest(req: Request, url: URL, clientIpValue: string): Promise<Response | null> {
  const match = api.match(req.method, url.pathname);
  if (!match) return null;

  const cookiesHeader = req.headers.get("cookie");
  const ctx = buildContext(
    new Request(req.url, {
      method: req.method,
      headers: (() => {
        const headers = new Headers(req.headers);
        headers.set("x-rslmc-client-ip", clientIpValue);
        return headers;
      })(),
      body: SAFE_METHODS.has(req.method) ? undefined : req.body,
      // @ts-expect-error Bun supports duplex for streaming request bodies
      duplex: "half",
    }),
    url,
    match.params,
    cookiesHeader,
  );

  try {
    // --- Rate limiting for mutating endpoints -------------------------------------------
    if (!SAFE_METHODS.has(req.method)) {
      const limiter = rateLimit(`api:${clientIpValue}:${url.pathname}`, 120, 60_000);
      if (!limiter.allowed) {
        return json({ error: { code: "rate_limited", message: `Slow down — retry in ${limiter.retryAfterSeconds}s` } }, {
          status: 429, headers: { "retry-after": String(limiter.retryAfterSeconds) },
        });
      }
    }

    // --- Session ------------------------------------------------------------------------
    const token = ctx.cookies[SESSION_COOKIE];
    if (token) {
      const session = validateSession(token);
      if (session) {
        ctx.user = session.user;
        ctx.session = { id: session.sessionId, csrfToken: session.csrfToken };
      }
    }

    const key = `${req.method} ${url.pathname}`;
    /*
     * Exact matches first (cheap), then the same set expressed as patterns so parameterised public
     * routes (`/api/auth/oauth/:provider/start`) are recognised instead of being bounced to the
     * login page with a 401.
     */
    const isPublic = PUBLIC_ROUTES.has(key)
      || [...PUBLIC_ROUTE_PATTERNS].some((pattern) => new RegExp(`^${pattern}$`).test(key));
    const needsAuth = !isPublic && !(req.method === "GET" && url.pathname === "/api/auth/me");
    if (needsAuth && !ctx.user) {
      return json({ error: { code: "unauthorized", message: "Authentication required" } }, { status: 401 });
    }

    // --- CSRF ---------------------------------------------------------------------------
    if (!SAFE_METHODS.has(req.method) && !isPublic) {
      const header = req.headers.get("x-csrf-token");
      if (!header || !ctx.session || header !== ctx.session.csrfToken) {
        return json({ error: { code: "csrf_invalid", message: "Invalid or missing CSRF token. Reload the panel and try again." } }, { status: 403 });
      }
      const origin = req.headers.get("origin");
      if (origin) {
        const expected = `${url.protocol}//${url.host}`;
        const forwardedHost = req.headers.get("x-forwarded-host");
        const forwardedProto = req.headers.get("x-forwarded-proto");
        const allowed = [expected, forwardedHost ? `${forwardedProto ?? "https"}://${forwardedHost}` : null].filter(Boolean);
        if (!allowed.includes(origin)) {
          return json({ error: { code: "origin_invalid", message: "Cross-origin request rejected" } }, { status: 403 });
        }
      }
    }

    const response = await match.route.handler(ctx);
    return response;
  } catch (error) {
    return jsonError(error);
  }
}

export function describeRoutes(): string[] {
  return api.list();
}

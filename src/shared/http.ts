/** Minimal, dependency-free HTTP helpers: typed errors, router, validation, cookies. */

export class ApiException extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) => new ApiException(400, "bad_request", message, details);
export const unauthorized = (message = "Authentication required") => new ApiException(401, "unauthorized", message);
export const forbidden = (message = "You do not have permission to perform this action") => new ApiException(403, "forbidden", message);
export const notFound = (message = "Not found") => new ApiException(404, "not_found", message);
export const conflict = (message: string, details?: unknown) => new ApiException(409, "conflict", message, details);
export const tooMany = (message = "Too many requests") => new ApiException(429, "rate_limited", message);
export const unavailable = (message: string) => new ApiException(503, "unavailable", message);

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function jsonError(error: unknown): Response {
  if (error instanceof ApiException) {
    return json({ error: { code: error.code, message: error.message, details: error.details } }, { status: error.status });
  }
  // An unexpected error is a bug in the panel, not something the caller can act on, and its message
  // is often a raw SQLite or filesystem string ("25 values for 24 columns", "/var/lib/…"). Log the
  // whole thing with a short reference and hand the caller only that reference, so a report can be
  // matched to the log line without leaking the schema or the disk layout.
  const ref = crypto.randomUUID().slice(0, 8);
  console.error(`[rslmc] unhandled error (ref ${ref}):`, error);
  return json(
    {
      error: {
        code: "internal_error",
        message: `The panel hit an unexpected error (ref ${ref}). The details are in the panel log.`,
        ref,
      },
    },
    { status: 500 },
  );
}

export type Handler = (ctx: RequestContext) => Promise<Response> | Response;

export interface Route {
  method: string;
  pattern: string;
  keys: string[];
  regex: RegExp;
  handler: Handler;
  meta?: { public?: boolean; permission?: string; rateLimit?: { limit: number; windowMs: number } };
}

export interface RequestContext {
  req: Request;
  url: URL;
  params: Record<string, string>;
  headers: Headers;
  clientIp: string;
  body: <T = any>() => Promise<T>;
  query: (key: string) => string | null;
  /** Attached by the auth layer. */
  user?: import("./types").UserPublic;
  session?: { id: string; csrfToken: string };
  setCookie: (cookie: string) => void;
  cookies: Record<string, string>;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler, meta?: Route["meta"]): this {
    const keys: string[] = [];
    const regexSrc = pattern
      .split("/")
      .map((segment) => {
        if (segment === "*") {
          // Trailing wildcard: captures the remainder of the path (used by the map file server).
          keys.push("rest");
          return "(.*)";
        }
        if (segment.startsWith(":")) {
          keys.push(segment.slice(1));
          return "([^/]+)";
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("/");
    this.routes.push({ method, pattern, keys, regex: new RegExp(`^${regexSrc}$`), handler, meta });
    return this;
  }

  get(p: string, h: Handler, m?: Route["meta"]) { return this.add("GET", p, h, m); }
  post(p: string, h: Handler, m?: Route["meta"]) { return this.add("POST", p, h, m); }
  put(p: string, h: Handler, m?: Route["meta"]) { return this.add("PUT", p, h, m); }
  patch(p: string, h: Handler, m?: Route["meta"]) { return this.add("PATCH", p, h, m); }
  delete(p: string, h: Handler, m?: Route["meta"]) { return this.add("DELETE", p, h, m); }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    /*
     * Most specific route wins, not "whichever was registered first".
     *
     * `/api/nodes/self/key` and `/api/nodes/:id/key` both match `/api/nodes/self/key`. Registration
     * order decided it before, so adding the static route after the parameterised one silently turned
     * `self` into a node id and answered "Node not found". Counting the dynamic segments (and then
     * preferring the longer, more literal pattern) makes a literal path always beat a placeholder.
     */
    let best: { route: Route; params: Record<string, string>; score: number } | null = null;
    for (const route of this.routes) {
      if (route.method !== method && !(method === "HEAD" && route.method === "GET")) continue;
      const m = route.regex.exec(pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((key, i) => { params[key] = decodeURIComponent(m[i + 1] ?? ""); });
      const dynamic = route.keys.length;
      // A longer pattern with the same number of placeholders is the more specific one.
      const score = dynamic * 10_000 - route.pattern.length;
      if (!best || score < best.score) best = { route, params, score };
    }
    return best ? { route: best.route, params: best.params } : null;
  }

  get size() { return this.routes.length; }
  list() { return this.routes.map((r) => `${r.method} ${r.pattern}`); }
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
  }
  return out;
}

export function serializeCookie(
  name: string,
  value: string,
  opts: { maxAge?: number; httpOnly?: boolean; secure?: boolean; sameSite?: "Strict" | "Lax" | "None"; path?: string } = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? "/"}`);
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  parts.push(`SameSite=${opts.sameSite ?? "Lax"}`);
  return parts.join("; ");
}

/** Small schema validator: keeps request parsing consistent without extra dependencies. */
type Validator<T> = (value: unknown) => { ok: true; value: T } | { ok: false; message: string };
export const v = {
  string(opts: { min?: number; max?: number; pattern?: RegExp; optional?: boolean; trim?: boolean } = {}): Validator<string | undefined> {
    return (value) => {
      if (value === undefined || value === null || value === "") {
        if (opts.optional) return { ok: true, value: undefined };
        return { ok: false, message: "is required" };
      }
      if (typeof value !== "string") return { ok: false, message: "must be a string" };
      const str = opts.trim === false ? value : value.trim();
      if (opts.min !== undefined && str.length < opts.min) return { ok: false, message: `must be at least ${opts.min} characters` };
      if (opts.max !== undefined && str.length > opts.max) return { ok: false, message: `must be at most ${opts.max} characters` };
      if (opts.pattern && !opts.pattern.test(str)) return { ok: false, message: "has an invalid format" };
      return { ok: true, value: str };
    };
  },
  number(opts: { min?: number; max?: number; optional?: boolean; integer?: boolean } = {}): Validator<number | undefined> {
    return (value) => {
      if (value === undefined || value === null || value === "") {
        if (opts.optional) return { ok: true, value: undefined };
        return { ok: false, message: "is required" };
      }
      const num = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(num)) return { ok: false, message: "must be a number" };
      if (opts.integer && !Number.isInteger(num)) return { ok: false, message: "must be an integer" };
      if (opts.min !== undefined && num < opts.min) return { ok: false, message: `must be at least ${opts.min}` };
      if (opts.max !== undefined && num > opts.max) return { ok: false, message: `must be at most ${opts.max}` };
      return { ok: true, value: num };
    };
  },
  boolean(opts: { optional?: boolean } = {}): Validator<boolean | undefined> {
    return (value) => {
      if (value === undefined || value === null) {
        if (opts.optional) return { ok: true, value: undefined };
        return { ok: false, message: "is required" };
      }
      if (typeof value === "boolean") return { ok: true, value };
      if (value === "true" || value === 1 || value === "1") return { ok: true, value: true };
      if (value === "false" || value === 0 || value === "0") return { ok: true, value: false };
      return { ok: false, message: "must be a boolean" };
    };
  },
  oneOf<T extends string>(values: readonly T[], opts: { optional?: boolean } = {}): Validator<T | undefined> {
    return (value) => {
      if (value === undefined || value === null || value === "") {
        if (opts.optional) return { ok: true, value: undefined };
        return { ok: false, message: "is required" };
      }
      if (typeof value !== "string" || !values.includes(value as T)) {
        return { ok: false, message: `must be one of: ${values.join(", ")}` };
      }
      return { ok: true, value: value as T };
    };
  },
  array<T>(inner: (value: unknown) => T, opts: { optional?: boolean; max?: number } = {}): Validator<T[] | undefined> {
    return (value) => {
      if (value === undefined || value === null) {
        if (opts.optional) return { ok: true, value: undefined };
        return { ok: false, message: "is required" };
      }
      if (!Array.isArray(value)) return { ok: false, message: "must be an array" };
      if (opts.max !== undefined && value.length > opts.max) return { ok: false, message: `must contain at most ${opts.max} items` };
      const out: T[] = [];
      for (const item of value) {
        try { out.push(inner(item)); } catch (err) { return { ok: false, message: err instanceof Error ? err.message : "invalid item" }; }
      }
      return { ok: true, value: out };
    };
  },
};

export type Validated<T extends Record<string, Validator<any>>> = {
  [K in keyof T]: Extract<ReturnType<T[K]>, { ok: true }>["value"];
};

export function validate<T extends Record<string, Validator<any>>>(
  schema: T,
  input: Record<string, unknown>,
): Validated<T> {
  const out: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const [key, validator] of Object.entries(schema ?? {})) {
    // `ctx.body()` is typed `any`, so calling validate(body, schema) instead of
    // validate(schema, body) type-checks happily and then explodes deep inside the loop with
    // "validator is not a function. (… 'validator' is 30)" — the 30 being a request value, which
    // says nothing about the real mistake. Say it plainly instead.
    if (typeof validator !== "function") {
      throw new Error(
        `validate(): arguments look swapped — "${key}" in the schema slot is a ${typeof validator}, ` +
          `not a validator. Call validate(schema, body).`,
      );
    }
    const result = validator(input?.[key]);
    if (!result.ok) errors[key] = result.message;
    else out[key] = result.value;
  }
  if (Object.keys(errors).length > 0) throw badRequest("Validation failed", errors);
  return out as any;
}

export function pagination(url: URL, defaultPerPage = 25): { page: number; perPage: number; offset: number } {
  const page = Math.max(1, Math.floor(Number(url.searchParams.get("page") ?? 1)) || 1);
  const perPage = Math.min(200, Math.max(1, Math.floor(Number(url.searchParams.get("perPage") ?? defaultPerPage)) || defaultPerPage));
  return { page, perPage, offset: (page - 1) * perPage };
}

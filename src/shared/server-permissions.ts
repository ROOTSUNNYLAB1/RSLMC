import type { Permission } from "./permissions";

/**
 * Who may call which per-server route — one table, used twice.
 *
 * The panel has two ways to reach these routes: locally (`api/server-routes.ts`, which calls
 * `requireServer(ctx, …)` inside each handler) and through the node proxy (`nodes/proxy.ts`, which
 * forwards a request for a server that lives on another machine and applies the check itself). Those
 * two used to be written independently, and they drifted: the proxy demanded `server.settings` for
 * the EULA and the startup preset, which the default `User` role does not hold, so the same account
 * could accept the EULA on a local server and got `403` on a remote one.
 *
 * This table is the local routes written down. `tests/server-permissions.test.ts` parses
 * `src/api/server-routes.ts` and fails if the two ever disagree again, so adding a route means
 * updating exactly one list and the test tells you if you forget.
 *
 * `ACCESS` means "anyone who can reach the server" (`server.view` plus ownership/sub-user access),
 * which is what `requireServer(ctx)` with no permission argument does.
 */
export const ACCESS = "access" as const;
export type PermissionExpr = Permission | readonly Permission[] | typeof ACCESS;

export interface ServerRouteRule {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path as registered on the local router, with `:param` segments and an optional trailing `/*`. */
  path: string;
  permission: PermissionExpr;
}

export const SERVER_ROUTE_PERMISSIONS: ServerRouteRule[] = [
  { method: "GET", path: "/api/servers/:id", permission: ACCESS },
  { method: "PATCH", path: "/api/servers/:id", permission: "server.settings" },
  { method: "DELETE", path: "/api/servers/:id", permission: "server.delete" },

  { method: "POST", path: "/api/servers/:id/eula", permission: "server.start" },
  // The action lives in the body; the proxy resolves it before calling this table.
  { method: "POST", path: "/api/servers/:id/power", permission: ACCESS },

  { method: "GET", path: "/api/servers/:id/console", permission: ACCESS },
  { method: "POST", path: "/api/servers/:id/console", permission: "server.command" },
  { method: "GET", path: "/api/servers/:id/metrics", permission: ACCESS },

  { method: "GET", path: "/api/servers/:id/properties", permission: ACCESS },
  { method: "PUT", path: "/api/servers/:id/properties", permission: ["server.settings", "server.files"] },

  { method: "GET", path: "/api/servers/:id/players", permission: ACCESS },
  { method: "POST", path: "/api/servers/:id/players/action", permission: "server.players" },
  { method: "POST", path: "/api/servers/:id/players/whitelist", permission: "server.players" },
  { method: "GET", path: "/api/servers/:id/players/:uuid/data", permission: "server.players" },
  { method: "POST", path: "/api/servers/:id/players/:uuid/data", permission: "server.players" },
  { method: "GET", path: "/api/servers/:id/players/:uuid/sessions", permission: ACCESS },

  { method: "GET", path: "/api/servers/:id/worlds", permission: ACCESS },
  { method: "POST", path: "/api/servers/:id/worlds", permission: "server.worlds" },
  { method: "DELETE", path: "/api/servers/:id/worlds/:worldId", permission: "server.worlds" },
  { method: "PATCH", path: "/api/servers/:id/worlds/:worldId", permission: "server.worlds" },

  { method: "GET", path: "/api/servers/:id/backups", permission: ACCESS },
  { method: "POST", path: "/api/servers/:id/backups", permission: "server.backups" },
  { method: "DELETE", path: "/api/servers/:id/backups/:backupId", permission: "server.backups" },
  { method: "POST", path: "/api/servers/:id/backups/:backupId/restore", permission: "server.backups" },
  { method: "GET", path: "/api/servers/:id/backups/:backupId/verify", permission: "server.backups" },
  { method: "GET", path: "/api/servers/:id/backups/:backupId/download", permission: "server.backups" },

  { method: "GET", path: "/api/servers/:id/schedules", permission: ACCESS },
  { method: "POST", path: "/api/servers/:id/schedules", permission: "server.schedules" },
  { method: "PATCH", path: "/api/servers/:id/schedules/:scheduleId", permission: "server.schedules" },
  { method: "DELETE", path: "/api/servers/:id/schedules/:scheduleId", permission: "server.schedules" },
  { method: "POST", path: "/api/servers/:id/schedules/:scheduleId/run", permission: "server.schedules" },
  { method: "GET", path: "/api/servers/:id/schedules/:scheduleId/runs", permission: ACCESS },

  { method: "GET", path: "/api/servers/:id/activity", permission: ACCESS },

  { method: "GET", path: "/api/servers/:id/settings", permission: ["server.settings", "server.allocations"] },
  { method: "GET", path: "/api/servers/:id/startup-options", permission: ["server.startup", "server.settings"] },
  { method: "PUT", path: "/api/servers/:id/startup-options", permission: "server.startup" },
  { method: "POST", path: "/api/servers/:id/reinstall", permission: "server.settings" },

  { method: "GET", path: "/api/servers/:id/allocations", permission: "server.allocations" },
  { method: "POST", path: "/api/servers/:id/allocations", permission: "server.allocations" },

  { method: "GET", path: "/api/servers/:id/plugins", permission: ACCESS },
  { method: "POST", path: "/api/servers/:id/plugins/recommended", permission: "server.plugins" },
  { method: "POST", path: "/api/servers/:id/plugins/install", permission: "server.plugins" },
  { method: "POST", path: "/api/servers/:id/plugins/updates", permission: "server.plugins" },
  { method: "DELETE", path: "/api/servers/:id/plugins/:pluginId", permission: "server.plugins" },

  { method: "GET", path: "/api/servers/:id/seed-map", permission: ACCESS },
  { method: "GET", path: "/api/servers/:id/map", permission: ACCESS },
  { method: "GET", path: "/api/servers/:id/map/web/*", permission: ACCESS },
  { method: "POST", path: "/api/servers/:id/map/setup", permission: "server.plugins" },

  /* File manager and the console socket live in their own routers (file-routes.ts, ws.ts). */
  { method: "GET", path: "/api/servers/:id/files", permission: ACCESS },
  { method: "GET", path: "/api/servers/:id/files/*", permission: "server.files" },
  { method: "POST", path: "/api/servers/:id/files/*", permission: "server.files" },
  { method: "PUT", path: "/api/servers/:id/files/*", permission: "server.files" },
  { method: "DELETE", path: "/api/servers/:id/files/*", permission: "server.files" },
  { method: "PATCH", path: "/api/servers/:id/files/*", permission: "server.files" },
];

/** The permission a `POST /power` action needs — mirrors the switch in server-routes.ts. */
export function powerActionPermission(action: string): Permission {
  const normalised = action.trim().toLowerCase();
  if (normalised === "kill") return "server.kill";
  if (normalised === "start") return "server.start";
  if (normalised === "stop") return "server.stop";
  return "server.restart";
}

const isPowerAction = (action: string): boolean =>
  ["start", "stop", "restart", "kill"].includes(action.trim().toLowerCase());

function segments(path: string): string[] {
  return path.split("/").filter((part) => part !== "");
}

/**
 * Matches a concrete request path against a rule's path.
 * `:param` matches exactly one segment; a trailing `*` matches the rest (or nothing).
 */
export function pathMatches(pattern: string, candidate: string): boolean {
  const want = segments(pattern);
  const got = segments(candidate);
  for (let index = 0; index < want.length; index += 1) {
    const part = want[index]!;
    if (part === "*") return true;                       // trailing wildcard
    if (index >= got.length) return false;
    if (part.startsWith(":")) continue;                  // parameter segment
    if (part !== got[index]) return false;
  }
  return got.length === want.length;
}

export interface ServerPermissionLookup {
  /** `null` means no rule matched: the caller must refuse, not guess. */
  permission: PermissionExpr | null;
  /** For a `allowed`-by-operator log line or a 403 message. */
  rule: ServerRouteRule | null;
  reason?: string;
}

/**
 * Resolves the permission for a per-server request.
 *
 * `body` is read only for `POST …/power`, where the action (not the path) decides: `kill` needs
 * `server.kill`, not whatever `server.start` the generic rule would have implied.
 */
export function serverPermissionFor(
  method: string,
  path: string,
  body?: unknown,
): ServerPermissionLookup {
  const verb = method.toUpperCase();
  if (path === "/api/servers/:id/power" || /^\/api\/servers\/[^/]+\/power\/?$/.test(path)) {
    const action = String((body as { action?: unknown } | undefined)?.action ?? "");
    if (!isPowerAction(action)) {
      return { permission: null, rule: null, reason: `unknown power action “${action || "(none)"}”` };
    }
    return {
      permission: powerActionPermission(action),
      rule: { method: "POST", path: "/api/servers/:id/power", permission: ACCESS },
    };
  }
  // Longest patterns first, so `/players/:uuid/data` wins over `/players`.
  const rules = SERVER_ROUTE_PERMISSIONS
    .filter((rule) => rule.method === verb)
    .sort((a, b) => segments(b.path).length - segments(a.path).length);
  for (const rule of rules) {
    if (pathMatches(rule.path, path)) return { permission: rule.permission, rule };
  }
  return { permission: null, rule: null, reason: `no route rule for ${verb} ${path}` };
}

/** True when the expression is satisfied by the given permission list. */
export function permissionSatisfied(expr: PermissionExpr, held: string[]): boolean {
  if (held.includes("*")) return true;
  if (expr === ACCESS) return held.includes("server.view");
  const list: readonly string[] = typeof expr === "string" ? [expr] : (expr as readonly string[]);
  return list.some((permission) => held.includes(permission));
}

/** Human-readable form for an error message. */
export function describePermission(expr: PermissionExpr): string {
  if (expr === ACCESS) return "server.view";
  if (typeof expr === "string") return expr;
  return (expr as readonly string[]).join(" or ");
}

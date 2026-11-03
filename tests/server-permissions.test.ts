import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCESS, SERVER_ROUTE_PERMISSIONS, serverPermissionFor, permissionSatisfied,
  describePermission, pathMatches, powerActionPermission,
} from "../src/shared/server-permissions";
import { DEFAULT_ROLES } from "../src/shared/permissions";

/*
 * The node proxy authorises forwarded requests with `SERVER_ROUTE_PERMISSIONS`. The local routes
 * authorise themselves with `requireServer(ctx, …)` inside each handler. Those two must agree, or the
 * same account gets "allowed" on a local server and "403" on a remote one — which is exactly the bug
 * that shipped in v2026.11.02.1 (EULA, startup options and BlueMap setup all demanded
 * `server.settings`, which the default `User` role does not hold).
 *
 * This suite reads the real source of `api/server-routes.ts`, extracts every `api.<verb>("/api/servers…")`
 * registration together with the permission expression its handler passes to `requireServer`, and
 * compares it with the table. Adding or changing a route without updating the table fails here.
 */

const ROUTE_SOURCE = readFileSync(join(import.meta.dir, "..", "src", "api", "server-routes.ts"), "utf8");

interface DeclaredRoute { method: string; path: string; permission: string }

function declaredRoutes(): DeclaredRoute[] {
  // Split on route registrations, keeping the handler body as the chunk that follows each one.
  const parts = ROUTE_SOURCE.split(/\n\s{2}api\.(get|post|put|patch|delete)\("(\/api\/servers[^"]*)"/);
  const routes: DeclaredRoute[] = [];
  for (let index = 1; index < parts.length; index += 3) {
    const method = parts[index]!.toUpperCase();
    const path = parts[index + 1]!;
    const body = (parts[index + 2] ?? "").slice(0, 1500);
    // requireServer(ctx, "x") / requireServer(ctx, ["x","y"]) / requireServerAccess(ctx.user, id, …)
    const match = /requireServer\(ctx,\s*(\[[^\]]*\]|"[^"]*")|requireServerAccess\(ctx\.user,\s*\w+,\s*(\[[^\]]*\]|"[^"]*")/.exec(body);
    const raw = match ? (match[1] ?? match[2])! : null;
    const permission = raw === null
      ? ACCESS
      : raw.startsWith("[")
        ? raw.replace(/[[\]"]/g, "").split(",").map((value) => value.trim()).filter(Boolean).sort().join("|")
        : raw.replace(/"/g, "");
    routes.push({ method, path, permission });
  }
  return routes;
}

const normalise = (permission: string | readonly string[]): string =>
  permission === ACCESS ? ACCESS
    : typeof permission === "string" ? permission
      : [...permission].sort().join("|");

describe("the proxy's permission table matches the local routes", () => {
  const routes = declaredRoutes();

  test("every local per-server route was found", () => {
    // A parser that silently matches nothing would make the rest of this suite vacuous.
    expect(routes.length).toBeGreaterThan(45);
    expect(routes.some((route) => route.path.endsWith("/eula"))).toBe(true);
  });

  // The collection routes (`/api/servers`) and `/power` are not path-decided: the first are not
  // per-server requests at all (the proxy never sees them), the second is decided by the body and has
  // its own suite below.
  const tableDriven = routes.filter((route) =>
    route.path !== "/api/servers" && !route.path.endsWith("/power"));

  test("the per-server subset is the one being compared", () => {
    expect(tableDriven.length).toBeGreaterThan(45);
  });

  for (const route of tableDriven) {
    test(`${route.method} ${route.path} → ${route.permission}`, () => {
      const subPath = route.path.replace("/api/servers/:id", "") || "";
      const lookup = serverPermissionFor(route.method, `/api/servers/1${subPath}`);
      expect(lookup.permission).not.toBeNull();
      expect(normalise(lookup.permission!)).toBe(route.permission);
    });
  }
});

describe("deny by default", () => {
  test("an unlisted write is refused, not guessed", () => {
    const lookup = serverPermissionFor("POST", "/api/servers/1/frobnicate");
    expect(lookup.permission).toBeNull();
    expect(lookup.reason).toContain("no route rule");
  });

  test("an unlisted read is refused too", () => {
    expect(serverPermissionFor("GET", "/api/servers/1/nope/deeper").permission).toBeNull();
  });

  test("there is no catch-all row", () => {
    // The old table ended with `{ prefix: "", permission: "server.settings" }`, which matched
    // everything and made its own `if (!hit)` branch unreachable.
    expect(SERVER_ROUTE_PERMISSIONS.some((rule) => rule.path === "" || rule.path === "/api/servers/:id/")).toBe(false);
  });
});

describe("power actions are decided by the body", () => {
  test("kill needs server.kill, start needs server.start", () => {
    expect(serverPermissionFor("POST", "/api/servers/1/power", { action: "kill" }).permission).toBe("server.kill");
    expect(serverPermissionFor("POST", "/api/servers/1/power", { action: "start" }).permission).toBe("server.start");
    expect(serverPermissionFor("POST", "/api/servers/1/power", { action: "stop" }).permission).toBe("server.stop");
    expect(serverPermissionFor("POST", "/api/servers/1/power", { action: "restart" }).permission).toBe("server.restart");
  });

  test("an unknown or missing action is refused", () => {
    expect(serverPermissionFor("POST", "/api/servers/1/power", { action: "nuke" }).permission).toBeNull();
    expect(serverPermissionFor("POST", "/api/servers/1/power", {}).permission).toBeNull();
  });

  test("the action map agrees with the local switch", () => {
    // server-routes.ts: kill → server.kill, start → server.start, stop → server.stop, else restart.
    for (const [action, expected] of Object.entries({ kill: "server.kill", start: "server.start", stop: "server.stop", restart: "server.restart" })) {
      expect(powerActionPermission(action)).toBe(expected as never);
    }
  });
});

describe("the default User role can do what the proxy demands", () => {
  /*
   * The regression was not "the table is wrong" in the abstract: it was that a real built-in role
   * could not perform actions it can perform locally. These are the exact three reported.
   */
  const user = DEFAULT_ROLES.find((role) => role.name === "User")!.permissions as readonly string[];

  test("accepting the EULA", () => {
    const lookup = serverPermissionFor("POST", "/api/servers/1/eula");
    expect(permissionSatisfied(lookup.permission!, [...user])).toBe(true);
  });

  test("reading and saving the startup preset", () => {
    expect(permissionSatisfied(serverPermissionFor("GET", "/api/servers/1/startup-options").permission!, [...user])).toBe(true);
    expect(permissionSatisfied(serverPermissionFor("PUT", "/api/servers/1/startup-options").permission!, [...user])).toBe(true);
  });

  test("installing BlueMap", () => {
    expect(permissionSatisfied(serverPermissionFor("POST", "/api/servers/1/map/setup").permission!, [...user])).toBe(true);
  });

  test("but not changing resource settings", () => {
    expect(permissionSatisfied(serverPermissionFor("PATCH", "/api/servers/1").permission!, [...user])).toBe(false);
    expect(permissionSatisfied(serverPermissionFor("POST", "/api/servers/1/reinstall").permission!, [...user])).toBe(false);
  });

  test("a Viewer keeps the read listings", () => {
    const viewer = DEFAULT_ROLES.find((role) => role.name === "Viewer")!.permissions as readonly string[];
    for (const path of ["/worlds", "/backups", "/schedules", "/players"]) {
      expect(permissionSatisfied(serverPermissionFor("GET", `/api/servers/1${path}`).permission!, [...viewer])).toBe(true);
    }
  });
});

describe("path matching", () => {
  test("parameters match exactly one segment", () => {
    expect(pathMatches("/api/servers/:id/worlds/:worldId", "/api/servers/4/worlds/9")).toBe(true);
    expect(pathMatches("/api/servers/:id/worlds/:worldId", "/api/servers/4/worlds/9/extra")).toBe(false);
    expect(pathMatches("/api/servers/:id", "/api/servers/4")).toBe(true);
    expect(pathMatches("/api/servers/:id", "/api/servers/4/files")).toBe(false);
  });

  test("a trailing star matches the rest, including nothing", () => {
    expect(pathMatches("/api/servers/:id/map/web/*", "/api/servers/2/map/web/")).toBe(true);
    expect(pathMatches("/api/servers/:id/map/web/*", "/api/servers/2/map/web/a/b/c.png")).toBe(true);
  });

  test("more specific routes win", () => {
    // /players/:uuid/data must not be satisfied by the /players listing rule.
    expect(serverPermissionFor("GET", "/api/servers/1/players/abc/data").permission).toBe("server.players");
    expect(serverPermissionFor("GET", "/api/servers/1/players").permission).toBe(ACCESS);
  });
});

describe("descriptions", () => {
  test("an OR expression is spelled out", () => {
    expect(describePermission(["server.startup", "server.settings"])).toBe("server.startup or server.settings");
    expect(describePermission(ACCESS)).toBe("server.view");
  });
});

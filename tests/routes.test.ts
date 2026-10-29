import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

/*
 * "No dead controls" is a product promise, and the cheapest way to break it is a page that calls an
 * endpoint nobody registered: the button looks alive, the click answers 404, and no test notices.
 * This file reads the real route table out of `src/api` and every `/api/…` path out of `frontend`,
 * then insists that each call has a route behind it.
 */

const ROOT = join(import.meta.dir, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

function backendRoutes(): Set<string> {
  const routes = new Set<string>();
  for (const file of walk(join(ROOT, "src", "api"))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/\.(get|post|patch|put|delete)\(\s*["'`](\/api\/[^"'`]+)["'`]/g)) {
      routes.add(`${match[1]!.toUpperCase()} ${match[2]!}`);
    }
  }
  return routes;
}

function normalize(path: string): string {
  const withoutQuery = path.split("?")[0]!;
  return withoutQuery
    .replace(/\$\{[^}]*\}/g, ":p")
    .replace(/\/\d+/g, "/:p")
    .replace(/:[A-Za-z_]+/g, ":p")
    .replace(/\/+$/, "");
}

function frontendCalls(): { method: string; path: string; where: string }[] {
  const calls: { method: string; path: string; where: string }[] = [];
  for (const file of walk(join(ROOT, "frontend"))) {
    const text = readFileSync(file, "utf8");
    const where = file.slice(ROOT.length + 1);
    for (const match of text.matchAll(/\b(?:apiFetch|request|fetch)<?[^(]*\(\s*["'`](\/api\/[^"'`]+)["'`]/g)) {
      calls.push({ method: "GET", path: match[1]!, where });
    }
    for (const match of text.matchAll(/["'`](\/api\/[^"'`]+)["'`]\s*,\s*\{\s*method:\s*["'](GET|POST|PATCH|PUT|DELETE)["']/g)) {
      calls.push({ method: match[2]!, path: match[1]!, where });
    }
    for (const match of text.matchAll(/method:\s*["'](GET|POST|PATCH|PUT|DELETE)["'][\s\S]{0,160}?["'`](\/api\/[^"'`]+)["'`]/g)) {
      calls.push({ method: match[1]!, path: match[2]!, where });
    }
    for (const match of text.matchAll(/\bapi\.(get|post|patch|put|delete)<?[^(]*\(\s*["'`](\/api\/[^"'`]+)["'`]/g)) {
      calls.push({ method: match[1]!.toUpperCase(), path: match[2]!, where });
    }
  }
  return calls;
}

describe("every API call in the UI has a route", () => {
  const routes = backendRoutes();
  const calls = frontendCalls();

  test("the route table was actually read", () => {
    expect(routes.size).toBeGreaterThan(100);
    expect(routes.has("POST /api/servers")).toBe(true);
    expect(routes.has("GET /api/auth/me")).toBe(true);
  });

  test("the frontend calls were actually read", () => {
    expect(calls.length).toBeGreaterThan(50);
  });

  test("no page calls an endpoint that does not exist", () => {
    const normalRoutes = [...routes].map((entry) => {
      const [method, path] = entry.split(" ");
      return `${method} ${normalize(path!)}`;
    });
    const dead: string[] = [];
    for (const call of calls) {
      const wanted = `${call.method} ${normalize(call.path)}`;
      const hit = normalRoutes.some((route) => {
        if (route === wanted) return true;
        // A call may target a prefix of a longer route (…/power vs …/power/:p) or vice versa.
        return route.startsWith(`${wanted}/`) || wanted.startsWith(`${route}/`);
      });
      if (!hit) dead.push(`${call.method} ${call.path} — ${call.where}`);
    }
    expect(dead).toEqual([]);
  });
});

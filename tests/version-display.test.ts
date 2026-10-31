import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

/*
 * The panel must never show a version it is not.
 *
 * Dashboard → Panel health → "Build" was a hard-coded `RSLMC 1.0.0`, and the login footer fell back to
 * `v1.0.0` whenever setup status had not loaded. Both survived every release because nothing checks a
 * string that never changes: the activity feed said "panel update installed 2026.10.29.11" while the
 * card above it said 1.0.0. These tests pin the real value down twice — once in the source (no
 * hard-coded version in the UI) and once over HTTP (the number the UI renders is the one on disk).
 */

const ROOT = join(import.meta.dir, "..");
const PKG_VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
const DATA_DIR = mkdtempSync(join(tmpdir(), "rslmc-version-"));
const PORT = freePort();
const BASE = `http://127.0.0.1:${PORT}`;
let pid = 0;

function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

async function sleep(ms: number) { await new Promise((resolve) => setTimeout(resolve, ms)); }

beforeAll(async () => {
  const child = Bun.spawn([process.execPath, join(ROOT, "src", "index.ts")], {
    cwd: ROOT,
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, RSLMC_DATA_DIR: DATA_DIR, RSLMC_PORT: String(PORT), RSLMC_HOST: "127.0.0.1" },
  });
  pid = child.pid ?? 0;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${BASE}/login`)).status === 200) return; } catch { /* booting */ }
    await sleep(250);
  }
  throw new Error("panel did not boot");
}, 90_000);

afterAll(() => {
  if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("the panel reports its real version", () => {
  test("package.json carries a CalVer version", () => {
    expect(PKG_VERSION).toMatch(/^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/);
  });

  test("the admin overview carries the build number the dashboard renders", async () => {
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin123" }),
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const overview = await (await fetch(`${BASE}/api/admin/overview`, { headers: { cookie } })).json() as any;
    expect(overview?.panel?.version).toBe(PKG_VERSION);
    expect(overview?.panel?.bunVersion).toBe(Bun.version);
  }, 30_000);

  test("every API response is stamped with the version (what the client reads)", async () => {
    const response = await fetch(`${BASE}/api/setup/status`);
    expect(response.headers.get("x-rslmc-version")).toBe(PKG_VERSION);
  }, 20_000);
});

describe("no page hard-codes a version", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, out);
      else if (/\.(tsx|ts)$/.test(entry.name)) out.push(path);
    }
    return out;
  }

  test("the UI does not contain a literal version string", () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, "frontend"))) {
      const text = readFileSync(file, "utf8");
      const where = file.slice(ROOT.length + 1);
      // "RSLMC 1.0.0", "v1.0.0", or a fallback such as `version ?? "1.0.0"`.
      for (const match of text.matchAll(/RSLMC\s+\d+\.\d+\.\d+|\bv\d+\.\d+\.\d+\b|\?\?\s*["']\d+\.\d+\.\d+["']/g)) {
        // Minecraft version literals and comments about them are not panel versions.
        if (/minecraft|mc-version|gameVersion/i.test(match[0])) continue;
        const line = text.slice(0, match.index).split("\n").length;
        offenders.push(`${where}:${line} ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

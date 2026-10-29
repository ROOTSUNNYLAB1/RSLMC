import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

/*
 * Why this file exists.
 *
 * Release 2026.10.29.7 shipped an INSERT into `servers` with 24 column names and 25 values. TypeScript
 * was happy, the build was green, and every single "create server" click in production answered
 *
 *   500  {"error":{"code":"internal_error","message":"25 values for 24 columns"}}
 *
 * The only thing that catches this class of bug is asking a real SQLite database to store a real
 * server through the real HTTP API. So this suite boots the panel against a temp data root, logs in,
 * creates a server exactly the way the wizard does, and then reads the row back.
 *
 * Provisioning runs in the background and downloads a real jar, so the test asserts on the record and
 * the acceptance of the request — not on the download finishing.
 */

const DATA_DIR = mkdtempSync(join(tmpdir(), "rslmc-servers-"));
const ROOT = join(import.meta.dir, "..");
const PORT = freePort();
const BASE = `http://127.0.0.1:${PORT}`;

let panelPid = 0;
let cookie = "";
let csrf = "";

function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

async function sleep(ms: number) { await new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== null) return value;
    } catch { /* panel still booting */ }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function api(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers: {
      cookie,
      ...(init.body !== undefined ? { "content-type": "application/json", "x-csrf-token": csrf } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

function serverPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Test Server",
    ownerId: 1,
    nodeId: 1,
    software: "vanilla",
    mcVersion: "1.21.4",
    memoryMb: 1024,
    cpuPercent: 100,
    diskMb: 1024,
    bindIp: "0.0.0.0",
    port: freePort(),
    acceptEula: true,
    ...overrides,
  };
}

beforeAll(async () => {
  const child = Bun.spawn([process.execPath, join(ROOT, "src", "index.ts")], {
    cwd: ROOT,
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, RSLMC_DATA_DIR: DATA_DIR, RSLMC_PORT: String(PORT), RSLMC_HOST: "127.0.0.1" },
  });
  panelPid = child.pid ?? 0;

  await waitFor(async () => {
    try { return (await fetch(`${BASE}/login`)).status === 200 ? true : null; } catch { return null; }
  }, 60_000, "the panel to boot");

  const response = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" }),
  });
  if (response.status !== 200) throw new Error(`login failed: ${response.status}`);
  cookie = (response.headers.get("set-cookie") ?? "").split(";")[0]!;
  const me = await (await fetch(`${BASE}/api/auth/me`, { headers: { cookie } })).json() as any;
  csrf = me.csrfToken ?? me.session?.csrfToken ?? "";
}, 90_000);

afterAll(() => {
  if (panelPid) { try { process.kill(panelPid, "SIGKILL"); } catch { /* already gone */ } }
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("creating a server through the API", () => {
  let createdId = 0;

  test("the wizard payload is accepted and the row is really stored", async () => {
    const response = await api("/api/servers", { method: "POST", body: serverPayload() });
    const body = await response.json() as any;

    // The 2026.10.29.7 bug surfaced here as 500 "25 values for 24 columns".
    expect(body?.error?.message ?? "").not.toContain("values for");
    expect(response.status).toBe(201);
    expect(body.server?.id).toBeGreaterThan(0);
    expect(typeof body.installId).toBe("string");

    createdId = body.server.id;
    expect(["installing", "offline"]).toContain(body.server.status);

    // And it is in the database, not just in the response body.
    const db = new Database(join(DATA_DIR, "database", "rslmc.db"), { readonly: true });
    const row = db.query("SELECT id, uuid, name, owner_id, node_id, software, mc_version, port, status FROM servers WHERE id = ?")
      .get(createdId) as any;
    db.close();
    expect(row).toBeTruthy();
    expect(row.name).toBe("Test Server");
    expect(row.port).toBe(body.server.port ?? row.port);
    expect(row.uuid).toMatch(/^[0-9a-f-]{36}$/);
  }, 60_000);

  test("the server is listed and readable over the API", async () => {
    expect(createdId).toBeGreaterThan(0);
    const detail = await api(`/api/servers/${createdId}`);
    expect(detail.status).toBe(200);
    const payload = await detail.json() as any;
    expect(payload.server?.name ?? payload.name).toBe("Test Server");

    const list = await (await api("/api/servers")).json() as any;
    const servers = list.servers ?? list.data ?? list;
    expect(Array.isArray(servers)).toBe(true);
    expect(servers.some((server: any) => server.id === createdId)).toBe(true);
  }, 30_000);

  test("the port it claimed is recorded as an allocation", async () => {
    const db = new Database(join(DATA_DIR, "database", "rslmc.db"), { readonly: true });
    const row = db.query("SELECT node_id, port, server_id FROM allocations WHERE server_id = ?").get(createdId) as any;
    const link = db.query("SELECT allocation_id FROM server_allocations WHERE server_id = ?").get(createdId) as any;
    db.close();
    expect(row).toBeTruthy();
    expect(row.server_id).toBe(createdId);
    expect(link).toBeTruthy();
  }, 30_000);

  test("a second server on the same port is refused with an explanation, not a 500", async () => {
    const first = await api(`/api/servers/${createdId}`);
    const firstPort = (await first.json() as any).server?.port ?? (await new Database(join(DATA_DIR, "database", "rslmc.db"), { readonly: true })
      .query("SELECT port FROM servers WHERE id = ?").get(createdId) as any).port;
    const response = await api("/api/servers", { method: "POST", body: serverPayload({ name: "Port Clash", port: firstPort }) });
    expect(response.status).toBe(409);
    const body = await response.json() as any;
    expect(body.error.code).toBe("allocation_conflict");
    expect(body.error.message).toContain(String(firstPort));
  }, 30_000);

  test("creating without accepting the EULA is refused", async () => {
    const response = await api("/api/servers", { method: "POST", body: serverPayload({ name: "No Eula", acceptEula: false }) });
    expect(response.status).toBe(400);
    expect((await response.json() as any).error.code).toBe("eula_required");
  }, 30_000);
});

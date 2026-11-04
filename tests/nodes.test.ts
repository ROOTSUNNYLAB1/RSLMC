import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

/*
 * Multi-node support, end to end, with two real panels.
 *
 * "controller" and "node" are separate RSLMC processes on separate ports with separate data roots —
 * the same thing as two machines, minus the network hop. The test proves the whole chain:
 *
 *   register a node → it refuses the controller until the key is pasted on the node side
 *   → after enrolment the handshake works → a server created on the controller really appears in the
 *     node's database → per-server requests are forwarded (files, settings) → deleting it on the
 *     controller removes it on the node, with its files and its port allocation.
 *
 * The install itself is skipped (`install: false`) so the test never depends on downloading a jar;
 * the download path is the same one a local server uses and is covered by the servers suite.
 */

const ROOT = join(import.meta.dir, "..");
const CONTROLLER_DIR = mkdtempSync(join(tmpdir(), "rslmc-ctrl-"));
const NODE_DIR = mkdtempSync(join(tmpdir(), "rslmc-node-"));
const CONTROLLER_PORT = freePort();
const NODE_PORT = freePort();
const CONTROLLER = `http://127.0.0.1:${CONTROLLER_PORT}`;
const NODE = `http://127.0.0.1:${NODE_PORT}`;

let controllerPid = 0;
let nodePid = 0;
let controllerCookie = "";
let controllerCsrf = "";
let nodeCookie = "";
let nodeCsrf = "";
let nodeId = 0;
let agentKey = "";
let serverId = 0;

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
    } catch { /* still booting */ }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function panel(dataDir: string, port: number) {
  return Bun.spawn([process.execPath, join(ROOT, "src", "index.ts")], {
    cwd: ROOT,
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, RSLMC_DATA_DIR: dataDir, RSLMC_PORT: String(port), RSLMC_HOST: "127.0.0.1" },
  });
}

async function boot(base: string): Promise<void> {
  await waitFor(async () => {
    try { return (await fetch(`${base}/login`)).status === 200 ? true : null; } catch { return null; }
  }, 60_000, `${base} to boot`);
}

async function login(base: string): Promise<{ cookie: string; csrf: string }> {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" }),
  });
  if (response.status !== 200) throw new Error(`login on ${base} failed: ${response.status}`);
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0]!;
  const me = await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json() as any;
  return { cookie, csrf: me.csrfToken ?? me.session?.csrfToken ?? "" };
}

async function loginAs(base: string, username: string, password: string): Promise<{ cookie: string; csrf: string }> {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (response.status !== 200) throw new Error(`login ${username} on ${base} failed: ${response.status}`);
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0]!;
  const me = await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json() as any;
  return { cookie, csrf: me.csrfToken ?? "" };
}

function call(base: string, cookie: string, csrf: string, path: string, init: { method?: string; body?: unknown } = {}) {
  return fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: {
      cookie,
      ...(init.body !== undefined ? { "content-type": "application/json", "x-csrf-token": csrf } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

beforeAll(async () => {
  const controller = panel(CONTROLLER_DIR, CONTROLLER_PORT);
  const node = panel(NODE_DIR, NODE_PORT);
  controllerPid = controller.pid ?? 0;
  nodePid = node.pid ?? 0;
  await Promise.all([boot(CONTROLLER), boot(NODE)]);
  const c = await login(CONTROLLER);
  const n = await login(NODE);
  controllerCookie = c.cookie;
  controllerCsrf = c.csrf;
  nodeCookie = n.cookie;
  nodeCsrf = n.csrf;
}, 120_000);

afterAll(() => {
  for (const pid of [controllerPid, nodePid]) {
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  }
  rmSync(CONTROLLER_DIR, { recursive: true, force: true });
  rmSync(NODE_DIR, { recursive: true, force: true });
});

describe("a second panel becomes a node", () => {
  test("registering a node returns a key and the node refuses it until it is installed", async () => {
    const response = await call(CONTROLLER, controllerCookie, controllerCsrf, "/api/nodes", {
      method: "POST",
      body: { name: "test-node", fqdn: "127.0.0.1", scheme: "http", port: NODE_PORT, location: "test" },
    });
    expect(response.status).toBe(201);
    const body = await response.json() as any;
    expect(body.agentKey.length).toBeGreaterThanOrEqual(24);
    // Nothing has been pasted into the node yet, so it must refuse.
    expect(body.reachable).toBe(false);
    expect(String(body.probeError)).toContain("rejected the controller key");
    expect(body.node.online).toBe(false);
    expect(body.node.hasKey).toBe(true);
    nodeId = body.id;
    agentKey = body.agentKey;
  }, 60_000);

  test("the node rejects a wrong key, not just an empty one", async () => {
    const response = await fetch(`${NODE}/api/agent/handshake`, {
      headers: { authorization: "Bearer this-is-not-the-key-but-it-is-long-enough" },
    });
    expect(response.status).toBe(401);
  }, 30_000);

  test("pasting the key on the node enrols it", async () => {
    const saved = await call(NODE, nodeCookie, nodeCsrf, "/api/nodes/self/key", {
      method: "POST",
      body: { key: agentKey, controllerUrl: CONTROLLER },
    });
    expect(saved.status).toBe(200);
    const body = await saved.json() as any;
    expect(body.self.enabled).toBe(true);
    expect(body.self.fingerprint).toMatch(/^[0-9a-f]{12}$/);
  }, 30_000);

  test("the controller's test now succeeds and reports the node's real machine figures", async () => {
    const response = await call(CONTROLLER, controllerCookie, controllerCsrf, `/api/nodes/${nodeId}/test`, { method: "POST", body: {} });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.ok).toBe(true);
    expect(body.version).toMatch(/^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/);
    expect(body.apiVersion).toBe(1);
    expect(body.node.online).toBe(true);
    expect(body.node.stats.cpuCores).toBeGreaterThan(0);
    expect(body.node.stats.memoryTotalBytes).toBeGreaterThan(0);
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);
  }, 60_000);

  test("the node records that it is enrolled, and never exposes its key", async () => {
    const self = await (await call(NODE, nodeCookie, nodeCsrf, "/api/nodes/self")).json() as any;
    expect(self.self.enabled).toBe(true);
    expect(JSON.stringify(self)).not.toContain(agentKey);
    // The controller's list must not hand the key back either.
    const list = await (await call(CONTROLLER, controllerCookie, controllerCsrf, "/api/nodes")).json() as any;
    expect(JSON.stringify(list)).not.toContain(agentKey);
  }, 30_000);
});

describe("servers on a remote node", () => {
  test("a server created on the controller really exists on the node", async () => {
    const response = await call(CONTROLLER, controllerCookie, controllerCsrf, "/api/servers", {
      method: "POST",
      body: {
        name: "Node Server", ownerId: 1, nodeId, software: "paper", mcVersion: "1.21.4",
        memoryMb: 1024, cpuPercent: 100, diskMb: 2048, bindIp: "0.0.0.0", port: freePort(), acceptEula: true,
      },
    });
    const text = await response.text();
    expect(text).not.toContain("node_");
    expect(response.status).toBe(201);
    const body = JSON.parse(text) as any;
    serverId = body.server.id;

    // It exists in the controller's database…
    const controllerDb = new Database(join(CONTROLLER_DIR, "database", "rslmc.db"), { readonly: true });
    const local = controllerDb.query("SELECT id, name, node_id FROM servers WHERE id = ?").get(serverId) as any;
    const link = controllerDb.query("SELECT remote_server_id FROM node_server_links WHERE server_id = ?").get(serverId) as any;
    controllerDb.close();
    expect(local).toBeTruthy();
    expect(local.node_id).toBe(nodeId);
    expect(link.remote_server_id).toBeGreaterThan(0);

    // …and in the node's own database, which is the machine that will run it.
    const nodeDb = new Database(join(NODE_DIR, "database", "rslmc.db"), { readonly: true });
    const remote = nodeDb.query("SELECT id, name FROM servers WHERE id = ?").get(link.remote_server_id) as any;
    nodeDb.close();
    expect(remote?.name).toBe("Node Server");
  }, 60_000);

  test("the controller's view of the server carries its own id, not the node's", async () => {
    const response = await call(CONTROLLER, controllerCookie, controllerCsrf, `/api/servers/${serverId}`);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.server.id).toBe(serverId);
    expect(body.server.nodeName).toBe("test-node");
    expect(body.server.managedByNode).toBe(true);
    expect(body.server.remoteServerId).toBeGreaterThan(0);
  }, 30_000);

  test("per-server requests are forwarded to the node", async () => {
    const files = await call(CONTROLLER, controllerCookie, controllerCsrf, `/api/servers/${serverId}/files`);
    expect(files.status).toBe(200);
    const listing = await files.json() as any;
    // Written by the node's own createServer, so a non-empty listing proves the request landed there.
    expect(listing.entries.map((entry: any) => entry.name)).toContain("server.properties");
  }, 30_000);

  test("a settings change is applied on both panels", async () => {
    const response = await call(CONTROLLER, controllerCookie, controllerCsrf, `/api/servers/${serverId}`, {
      method: "PATCH",
      body: { memoryMb: 1536 },
    });
    expect(response.status).toBe(200);

    const nodeDb = new Database(join(NODE_DIR, "database", "rslmc.db"), { readonly: true });
    const remote = nodeDb.query("SELECT memory_mb FROM servers ORDER BY id LIMIT 1").get() as any;
    nodeDb.close();
    expect(remote.memory_mb).toBe(1536);

    const controllerDb = new Database(join(CONTROLLER_DIR, "database", "rslmc.db"), { readonly: true });
    const local = controllerDb.query("SELECT memory_mb FROM servers WHERE id = ?").get(serverId) as any;
    controllerDb.close();
    expect(local.memory_mb).toBe(1536);
  }, 60_000);


  /*
   * R2 (round 51 follow-up): the proxy used to demand `server.settings` for the EULA, the startup
   * preset and BlueMap setup, while the local routes ask for `server.start`, `server.startup` and
   * `server.plugins`. The built-in `User` role holds the latter three and *not* the former, so the
   * same account could accept the EULA locally and got 403 on a remote server. This drives the real
   * proxy as a plain `User` account that owns the remote server.
   */
  test("a plain User can accept the EULA and read the startup options on a remote server", async () => {
    // A real (non-root) account with the default `User` role, then hand it the remote server.
    const created = await call(CONTROLLER, controllerCookie, controllerCsrf, "/api/users", {
      method: "POST",
      body: { username: "remoteuser", password: "Str0ngPass!23", roles: ["User"] },
    });
    expect(created.status).toBe(201);
    const remoteUserId = ((await created.json()) as any).id as number;

    const controllerDb = new Database(join(CONTROLLER_DIR, "database", "rslmc.db"), { readwrite: true });
    const previousOwner = (controllerDb.query("SELECT owner_id FROM servers WHERE id = ?").get(serverId) as any).owner_id;
    controllerDb.run("UPDATE servers SET owner_id = ? WHERE id = ?", [remoteUserId, serverId]);
    controllerDb.close();

    const plain = await loginAs(CONTROLLER, "remoteuser", "Str0ngPass!23");
    const perms = await (await fetch(`${CONTROLLER}/api/auth/me`, { headers: { cookie: plain.cookie } })).json() as any;
    expect(perms.user.isRoot).toBe(false);
    expect(perms.user.permissions).not.toContain("server.settings");

    const eula = await call(CONTROLLER, plain.cookie, plain.csrf, `/api/servers/${serverId}/eula`, {
      method: "POST",
      body: { accept: true },
    });
    // The proxy must not refuse it; the node answers 200 or a business error of its own.
    expect([401, 403]).not.toContain(eula.status);

    const startupRead = await call(CONTROLLER, plain.cookie, plain.csrf, `/api/servers/${serverId}/startup-options`);
    expect([401, 403]).not.toContain(startupRead.status);

    const startupWrite = await call(CONTROLLER, plain.cookie, plain.csrf, `/api/servers/${serverId}/startup-options`, {
      method: "PUT",
      body: { preset: "aikars" },
    });
    expect([401, 403]).not.toContain(startupWrite.status);

    // ...and the things a User genuinely may not do stay refused, remotely exactly as locally.
    const denied = await call(CONTROLLER, plain.cookie, plain.csrf, `/api/servers/${serverId}`, {
      method: "PATCH",
      body: { memoryMb: 2048 },
    });
    expect(denied.status).toBe(403);

    // An unlisted write is refused, not guessed as `server.settings` (R3).
    const unknown = await call(CONTROLLER, plain.cookie, plain.csrf, `/api/servers/${serverId}/frobnicate`, {
      method: "POST",
      body: { x: 1 },
    });
    expect(unknown.status).toBe(403);
    expect(((await unknown.json()) as any).error.code).toBe("unsupported_action");

    // The same two checks make sense locally, so a future drift fails on both sides.
    const localDenied = await call(CONTROLLER, plain.cookie, plain.csrf, `/api/servers/${serverId}/settings`);
    expect(localDenied.status).toBe(403);

    const restore = new Database(join(CONTROLLER_DIR, "database", "rslmc.db"), { readwrite: true });
    restore.run("UPDATE servers SET owner_id = ? WHERE id = ?", [previousOwner, serverId]);
    restore.close();
  }, 60_000);

  /*
   * N1 (audit 2): the sub-user scope added in `d79d5ac` was enforced by `requireServerAccess`, which
   * only local routes call. A share narrowed to `server.view` therefore restricted the account on a
   * local server and not on a remote one — the proxy checked the *role*, then ownership, and never
   * looked at `server_subusers.permissions`.
   *
   * This drives the real proxy over a real second panel: a shared account scoped to `server.view`
   * must read the remote server's files and must *not* be able to open a power action or the
   * console. `followup.o3` in the pentest covers the same contract locally; this is the remote half.
   */
  test("a sub-user's narrow scope is enforced through the node proxy too", async () => {
    const created = await call(CONTROLLER, controllerCookie, controllerCsrf, "/api/users", {
      method: "POST",
      body: { username: "scopeduser", password: "Str0ngPass!23", roles: ["User"] },
    });
    expect(created.status).toBe(201);
    const scopedId = ((await created.json()) as any).id as number;

    // Share the remote server with a scope of exactly two permissions: read the files, nothing else.
    const grant = await call(CONTROLLER, controllerCookie, controllerCsrf, `/api/users/${scopedId}/servers`, {
      method: "PUT",
      body: { owner: [], shared: [serverId], scope: { [serverId]: ["server.view", "server.files"] } },
    });
    expect(grant.status).toBe(200);

    const scoped = await loginAs(CONTROLLER, "scopeduser", "Str0ngPass!23");
    const me = await (await fetch(`${CONTROLLER}/api/auth/me`, { headers: { cookie: scoped.cookie } })).json() as any;
    // The role does hold these; only the share is narrow. That is what makes the check meaningful.
    expect(me.user.permissions).toContain("server.command");
    expect(me.user.isRoot).toBe(false);

    // Inside the scope: forwarded and answered by the node.
    const read = await call(CONTROLLER, scoped.cookie, scoped.csrf, `/api/servers/${serverId}/files`);
    expect([401, 403]).not.toContain(read.status);

    // Outside the scope: refused by the controller, never forwarded.
    const power = await call(CONTROLLER, scoped.cookie, scoped.csrf, `/api/servers/${serverId}/power`, {
      method: "POST",
      body: { action: "kill" },
    });
    expect(power.status).toBe(403);
    expect(((await power.json()) as any).error.code).toBe("subuser_scope");

    const consoleWrite = await call(CONTROLLER, scoped.cookie, scoped.csrf, `/api/servers/${serverId}/console`, {
      method: "POST",
      body: { command: "op someone" },
    });
    expect(consoleWrite.status).toBe(403);

    // Widening the share widens the remote path as well — the rule, not a hardcoded block.
    const widened = await call(CONTROLLER, controllerCookie, controllerCsrf, `/api/users/${scopedId}/servers`, {
      method: "PUT",
      body: { owner: [], shared: [serverId], scope: { [serverId]: ["server.view", "server.command"] } },
    });
    expect(widened.status).toBe(200);
    const allowed = await call(CONTROLLER, scoped.cookie, scoped.csrf, `/api/servers/${serverId}/console`, {
      method: "POST",
      body: { command: "say hello" },
    });
    // Forwarded: whatever the node says about a stopped server, it is no longer a permission refusal.
    expect(((await allowed.json().catch(() => ({}))) as any).error?.code ?? "").not.toBe("subuser_scope");

    // Undo the share so the delete test below sees a clean panel.
    await call(CONTROLLER, controllerCookie, controllerCsrf, `/api/users/${scopedId}/servers`, {
      method: "PUT",
      body: { owner: [], shared: [], scope: {} },
    });
  }, 90_000);

  test("an offline node cannot silently accept a server", async () => {
    // Stop the node, then try to create a server on it.
    try { process.kill(nodePid, "SIGKILL"); } catch { /* ignore */ }
    await sleep(1200);
    const response = await call(CONTROLLER, controllerCookie, controllerCsrf, "/api/servers", {
      method: "POST",
      body: {
        name: "Should Fail", ownerId: 1, nodeId, software: "paper", mcVersion: "1.21.4",
        memoryMb: 1024, cpuPercent: 100, diskMb: 2048, bindIp: "0.0.0.0", port: freePort(), acceptEula: true,
      },
    });
    expect(response.status).toBe(502);
    const body = await response.json() as any;
    expect(body.error.code).toBe("node_create_failed");
    // The failed attempt must not leave a record behind on the controller.
    const controllerDb = new Database(join(CONTROLLER_DIR, "database", "rslmc.db"), { readonly: true });
    const count = controllerDb.query("SELECT COUNT(*) AS c FROM servers").get() as any;
    controllerDb.close();
    expect(count.c).toBe(1);
  }, 60_000);

  test("deleting the server on the controller removes it from the node", async () => {
    // Bring the node back for the delete.
    const restarted = panel(NODE_DIR, NODE_PORT);
    nodePid = restarted.pid ?? 0;
    await boot(NODE);
    const response = await call(CONTROLLER, controllerCookie, controllerCsrf, `/api/servers/${serverId}`, {
      method: "DELETE",
      body: { confirmName: "Node Server", deleteFiles: true, deleteBackups: true },
    });
    expect(response.status).toBe(200);

    const nodeDb = new Database(join(NODE_DIR, "database", "rslmc.db"), { readonly: true });
    const remoteCount = nodeDb.query("SELECT COUNT(*) AS c FROM servers").get() as any;
    nodeDb.close();
    expect(remoteCount.c).toBe(0);

    const controllerDb = new Database(join(CONTROLLER_DIR, "database", "rslmc.db"), { readonly: true });
    const leftovers = controllerDb.query("SELECT COUNT(*) AS c FROM servers").get() as any;
    const links = controllerDb.query("SELECT COUNT(*) AS c FROM node_server_links").get() as any;
    controllerDb.close();
    expect(leftovers.c).toBe(0);
    expect(links.c).toBe(0);
  }, 90_000);
});

describe("a node key is not a way into a panel that has none", () => {
  test("the node's own normal routes still require a session", async () => {
    const response = await fetch(`${NODE}/api/servers`);
    expect(response.status).toBe(401);
  }, 20_000);

  test("a key from a different panel does not open the controller", async () => {
    const response = await fetch(`${CONTROLLER}/api/servers`, {
      headers: { authorization: `Bearer ${agentKey}` },
    });
    expect(response.status).toBe(401);
  }, 20_000);
});

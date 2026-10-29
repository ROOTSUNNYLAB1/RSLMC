import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

/*
 * The promise of this feature in one test:
 *
 *   start a server through the panel → restart the panel → the *same* server process is still
 *   running, its console history survived, it still accepts commands, and stopping it is graceful.
 *
 * A real Minecraft server is not required. The panel launches whatever binary the Java runtime row
 * points at, so a tiny Bun script stands in for `bin/java`: it prints the readiness line the manager
 * looks for, echoes stdin (so we can prove command routing works) and exits 0 on `stop`.
 */

const DATA_DIR = mkdtempSync(join(tmpdir(), "rslmc-survive-"));
const ROOT = join(import.meta.dir, "..");
// A fixed port made this suite collide with a panel left behind by an aborted run (the relauncher
// it tests survives the test process). Pick a free one instead.
const PORT = freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const UUID = "11111111-2222-3333-4444-555555555555";

let panelPid = 0;
let newestPid = 0;
let serverId = 0;
let serverPort = 0;
let cookie = "";
let csrf = "";
let javaPid = 0;

const FAKE_RUNTIME = join(DATA_DIR, "fake-java-runtime");
const FAKE_JAVA_SCRIPT = join(DATA_DIR, "fake-minecraft.ts");

async function sleep(ms: number) { await new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== null) return value;
    } catch (error) { last = error; }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}${last ? ` (${String(last)})` : ""}`);
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

async function serverState(): Promise<any | null> {
  const response = await api(`/api/servers/${serverId}`);
  if (response.status !== 200) return null;
  return response.json();
}

async function login(): Promise<void> {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" }),
  });
  if (response.status !== 200) throw new Error(`login failed: ${response.status}`);
  cookie = (response.headers.get("set-cookie") ?? "").split(";")[0]!;
  const me = await (await fetch(`${BASE}/api/auth/me`, { headers: { cookie } })).json() as any;
  csrf = me.csrfToken ?? me.session?.csrfToken ?? "";
}

function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

beforeAll(async () => {
  // A fake JDK: <runtime>/bin/java is a shell wrapper around the script below.
  mkdirSync(join(FAKE_RUNTIME, "bin"), { recursive: true });
  writeFileSync(FAKE_JAVA_SCRIPT, `
// Stand-in for a Minecraft server: readiness line, stdin echo, graceful stop.
console.log("[Server thread/INFO]: Starting minecraft server version 1.21.4");
console.log("[Server thread/INFO]: Done (1.234s)! For help, type \\"help\\"");
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  const text = decoder.decode(chunk).trim();
  if (!text) continue;
  console.log("[Server thread/INFO]: console ran: " + text);
  if (text === "stop") { console.log("[Server thread/INFO]: Stopping server"); process.exit(0); }
}
`);
  const wrapper = join(FAKE_RUNTIME, "bin", "java");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_JAVA_SCRIPT}" "$@"\n`);
  chmodSync(wrapper, 0o755);

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

  await login();

  // Server directory with a jar and an accepted EULA, then the rows the manager expects.
  serverPort = freePort();
  const directory = join(DATA_DIR, "servers", UUID);
  mkdirSync(join(directory, "plugins"), { recursive: true });
  writeFileSync(join(directory, "server.jar"), "not a real jar, never executed");
  writeFileSync(join(directory, "eula.txt"), "eula=true\n");
  writeFileSync(join(directory, "server.properties"), `server-port=${serverPort}\nmotd=RSLMC test\n`);

  const db = new Database(join(DATA_DIR, "database", "rslmc.db"));
  db.exec("PRAGMA busy_timeout = 5000;");
  const javaRuntimeId = db.query(
    `INSERT INTO java_runtimes (node_id, major, vendor, version, os, arch, image_type, path, java_executable, size_bytes, status)
     VALUES (1, 21, 'Test', '21.0.0-fake', 'linux', 'x64', 'jdk', ?, ?, 0, 'installed')`,
  ).run(FAKE_RUNTIME, join(FAKE_RUNTIME, "bin", "java")).lastInsertRowid as number;
  serverId = db.query(
    `INSERT INTO servers (uuid, name, owner_id, node_id, software, software_version, mc_version,
       java_runtime_id, java_major, status, memory_mb, cpu_percent, disk_mb, bind_ip, port,
       startup_command, jvm_args, server_args, eula_accepted, installed_at)
     VALUES (?, 'Survivor', 1, 1, 'vanilla', '1.21.4', '1.21.4', ?, 21, 'offline', 512, 50, 1024,
       '127.0.0.1', ?, 'java -Xms{memory}M -Xmx{memory}M -jar server.jar nogui', '', 'nogui', 1,
       strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
  ).run(UUID, javaRuntimeId, serverPort).lastInsertRowid as number;
  db.close();
});

afterAll(() => {
  // The relaunched panel is a detached process: kill whatever still listens on the port as well.
  try {
    const probe = Bun.spawnSync(["sh", "-c", `ss -ltnp 2>/dev/null | grep ':${PORT}' | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u`]);
    for (const pid of probe.stdout.toString().split("\n").map((v) => Number(v.trim())).filter(Boolean)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  } catch { /* no ss on this host */ }
  for (const pid of [panelPid, newestPid]) {
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ } }
  }
  if (javaPid) { try { process.kill(javaPid, "SIGKILL"); } catch { /* ignore */ } }
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("a server outlives a panel restart", () => {
  test("the server starts through the relay", async () => {
    const started = await api(`/api/servers/${serverId}/power`, { method: "POST", body: { action: "start" } });
    expect(started.status).toBe(200);

    const state = await waitFor(async () => {
      const data = await serverState();
      return data?.runtime?.status === "online" ? data : null;
    }, 60_000, "the server to report online");

    javaPid = state.runtime.pid;
    expect(javaPid).toBeGreaterThan(0);
    expect(state.runtime.ready).toBe(true);

    const relay = await fetch(`${BASE}/api/servers/${serverId}/console?limit=50`, { headers: { cookie } }).then((r) => r.json()) as any;
    const text = (relay.data ?? []).map((line: any) => line.text).join("\n");
    expect(text).toContain("Started through the RSLMC relay");
    expect(text).toContain("Done (1.234s)");
  }, 90_000);

  test("console commands work before the restart", async () => {
    const sent = await api(`/api/servers/${serverId}/console`, { method: "POST", body: { command: "say before" } });
    expect(sent.status).toBe(200);
    await waitFor(async () => {
      const data = await fetch(`${BASE}/api/servers/${serverId}/console?limit=50`, { headers: { cookie } }).then((r) => r.json()) as any;
      const text = (data.data ?? []).map((line: any) => line.text).join("\n");
      return text.includes("console ran: say before") ? true : null;
    }, 20_000, "the command to reach the server");
  }, 40_000);

  test("the panel restarts while the server keeps running", async () => {
    const restart = await api("/api/panel/restart", {
      method: "POST",
      body: { reason: "survive test", acknowledge: true },
    });
    expect(restart.status).toBe(202);

    await waitFor(async () => {
      try { process.kill(panelPid, 0); return null; } catch { return true; }
    }, 30_000, "the old panel to exit");

    // The server process must still be alive during the gap — this is the whole point.
    expect(() => process.kill(javaPid, 0)).not.toThrow();

    await waitFor(async () => {
      try { return (await fetch(`${BASE}/login`)).status === 200 ? true : null; } catch { return null; }
    }, 60_000, "the panel to come back");

    const state = await (await fetch(`${BASE}/api/panel/restart`, { headers: { cookie } })).json() as any;
    newestPid = state.pid;
    expect(newestPid).not.toBe(panelPid);
    expect(state.history[0].serversKept).toBeGreaterThanOrEqual(1);
  }, 120_000);

  test("the new panel reattaches to the same process with its console", async () => {
    const state = await waitFor(async () => {
      const data = await serverState();
      return data?.runtime?.status === "online" ? data : null;
    }, 60_000, "the server to be reattached");

    // Same JVM: the panel reconnected, it did not restart the server.
    expect(state.runtime.pid).toBe(javaPid);
    expect(state.runtime.foreign).toBe(false);
    expect(state.runtime.relayed).not.toBe(false);

    const console = await fetch(`${BASE}/api/servers/${serverId}/console?limit=200`, { headers: { cookie } }).then((r) => r.json()) as any;
    const text = (console.data ?? []).map((line: any) => line.text).join("\n");
    expect(text).toContain("kept running while RSLMC restarted");
    // History from before the restart is still there.
    expect(text).toContain("Done (1.234s)");
  }, 90_000);

  test("commands still work after the restart", async () => {
    const sent = await api(`/api/servers/${serverId}/console`, { method: "POST", body: { command: "say after" } });
    expect(sent.status).toBe(200);
    await waitFor(async () => {
      const data = await fetch(`${BASE}/api/servers/${serverId}/console?limit=50`, { headers: { cookie } }).then((r) => r.json()) as any;
      return (data.data ?? []).some((line: any) => line.text.includes("console ran: say after")) ? true : null;
    }, 20_000, "the command to reach the adopted server");
  }, 40_000);

  test("the server still stops gracefully through the relay", async () => {
    const stopped = await api(`/api/servers/${serverId}/power`, { method: "POST", body: { action: "stop" } });
    expect(stopped.status).toBe(200);
    const state = await waitFor(async () => {
      const data = await serverState();
      return data?.runtime?.status === "offline" ? data : null;
    }, 60_000, "the server to stop");
    expect(state.runtime.stopKind).toBe("graceful");
    expect(state.runtime.exitCode).toBe(0);
  }, 90_000);
});

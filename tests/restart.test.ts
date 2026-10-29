import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/*
 * "Restart RSLMC" against a real panel process.
 *
 * This is the only test that boots the panel as a separate process, presses the restart button over
 * HTTP and waits for the *new* process to answer. It is deliberately slow (~15 s) because the thing
 * being checked cannot be faked: the old pid must disappear, the relauncher must bring a new one up
 * on the same port, and the restart record must come back with measured timings.
 */

const DATA_DIR = mkdtempSync(join(tmpdir(), "rslmc-restart-"));
const PORT = 3987;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(import.meta.dir, "..");

let firstPid = 0;
let newestPid = 0;
let cookie = "";

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function panelAnswers(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE}/login`, { signal: AbortSignal.timeout(2000) });
    return response.status === 200;
  } catch {
    return false;
  }
}

function alive(pid: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

beforeAll(async () => {
  const child = Bun.spawn([process.execPath, join(ROOT, "src", "index.ts")], {
    cwd: ROOT,
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, RSLMC_DATA_DIR: DATA_DIR, RSLMC_PORT: String(PORT), RSLMC_HOST: "127.0.0.1" },
  });
  firstPid = child.pid ?? 0;
  await waitFor(panelAnswers, 60_000, "the panel to boot");
});

afterAll(() => {
  for (const pid of [firstPid, newestPid]) {
    if (pid && alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ } }
  }
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("panel restart", () => {
  test("the running panel reports its own pid", async () => {
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin123" }),
    });
    expect(login.status).toBe(200);
    cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(cookie).toContain("rslmc_session=");

    const state = await fetch(`${BASE}/api/panel/restart`, { headers: { cookie } });
    const body = await state.json() as any;
    expect(body.pid).toBe(firstPid);
    expect(body.canManage).toBe(true);
    expect(body.inProgress).toBe(false);
  }, 30_000);

  test("a restart without acknowledgement is refused", async () => {
    const me = await (await fetch(`${BASE}/api/auth/me`, { headers: { cookie } })).json() as any;
    const csrf = me.csrfToken ?? me.session?.csrfToken;
    expect(csrf).toBeTruthy();
    const response = await fetch(`${BASE}/api/panel/restart`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ reason: "test" }),
    });
    // The panel must still be running: nothing happened.
    expect(response.status).toBe(400);
    expect(alive(firstPid)).toBe(true);
  }, 30_000);

  test("the panel restarts itself and comes back on the same port", async () => {
    const me = await (await fetch(`${BASE}/api/auth/me`, { headers: { cookie } })).json() as any;
    const csrf = me.csrfToken ?? me.session?.csrfToken;
    const response = await fetch(`${BASE}/api/panel/restart`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ reason: "automated restart test", acknowledge: true }),
    });
    expect(response.status).toBe(202);
    const body = await response.json() as any;
    expect(body.restart.pid).toBe(firstPid);

    // The old process leaves…
    await waitFor(async () => !alive(firstPid), 30_000, "the old panel process to exit");
    // …and a new one answers on the same port.
    await waitFor(panelAnswers, 60_000, "the restarted panel to answer");

    const state = await (await fetch(`${BASE}/api/panel/restart`, { headers: { cookie } })).json() as any;
    newestPid = state.pid;
    expect(newestPid).toBeGreaterThan(0);
    expect(newestPid).not.toBe(firstPid);
    expect(alive(newestPid)).toBe(true);

    const completed = state.history[0];
    expect(completed.completedAt).toBeTruthy();
    expect(typeof completed.bootMs).toBe("number");
    expect(completed.bootMs).toBeGreaterThan(0);
    expect(completed.reason).toContain("automated restart test");
  }, 120_000);

  test("the session survives the restart and the panel is fully functional", async () => {
    // Sessions live in SQLite, not in memory: a restart must not sign the operator out.
    const me = await fetch(`${BASE}/api/auth/me`, { headers: { cookie } });
    expect(me.status).toBe(200);
    const about = await fetch(`${BASE}/api/panel/about`, { headers: { cookie } });
    expect(about.status).toBe(200);
    const payload = await about.json() as any;
    // CalVer: YYYY.MM.DD, plus ".N" for a second release on the same day.
    expect(payload.version).toMatch(/^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/);
    expect(payload.build.pid).toBe(newestPid);
    expect(payload.update.canManage).toBe(true);
    expect(payload.repository.slug).toContain("/");

    // Dashboard data (a route that touches the database) still works after the bounce.
    const overview = await fetch(`${BASE}/api/admin/overview`, { headers: { cookie } });
    expect(overview.status).toBe(200);
  }, 30_000);

  test("the restart log records what the relauncher did", async () => {
    const log = join(DATA_DIR, "logs", "restart.log");
    expect(existsSync(log)).toBe(true);
    const text = readFileSync(log, "utf8");
    expect(text).toContain("relauncher up");
    expect(text).toContain("started RSLMC again");
  }, 15_000);
});

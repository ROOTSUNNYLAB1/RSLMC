import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/*
 * The relay is what makes "Restart RSLMC" harmless for running servers, so it is tested without a
 * Minecraft server: a small Bun script stands in for the JVM. It prints, echoes what it is told on
 * stdin, and quits on "stop" — everything the panel relies on.
 *
 * The interesting half of this file is the *second* connection: the panel drops its socket (exactly
 * what happens when the panel process exits), and a fresh client reattaches to the still-running
 * process, replays the backlog and can still type into the console.
 */

const DATA_DIR = mkdtempSync(join(tmpdir(), "rslmc-relay-"));
process.env.RSLMC_DATA_DIR = DATA_DIR;

const FAKE_JAVA = join(DATA_DIR, "fake-java.ts");
writeFileSync(FAKE_JAVA, `
console.log("fake java booting");
console.log("Done (1.234s)! For help, type \\"help\\"");
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  const text = decoder.decode(chunk).trim();
  if (!text) continue;
  console.log("[echo] " + text);
  if (text === "stop") { console.log("Stopping server"); process.exit(0); }
}
`);

let relayClient: typeof import("../src/processes/relay-client");
const lines: string[] = [];
let exits: Array<{ code: number | null; signal: string | null }> = [];
let connection: Awaited<ReturnType<typeof relayClient.startRelay>> = null;

function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = setInterval(() => {
      if (predicate()) { clearInterval(poll); resolve(); return; }
      if (Date.now() > deadline) { clearInterval(poll); reject(new Error("timed out")); }
    }, 50);
  });
}

function alive(pid: number | null): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

beforeAll(async () => {
  relayClient = await import("../src/processes/relay-client");
});

afterAll(async () => {
  try { connection?.disconnect(); } catch { /* ignore */ }
  const state = relayClient.readRelayState(4242);
  if (state) { try { process.kill(state.relayPid, "SIGKILL"); } catch { /* ignore */ } }
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("relay", () => {
  test("starts a server and streams its console", async () => {
    connection = await relayClient.startRelay({
      serverId: 4242,
      uuid: "test-uuid",
      command: [process.execPath, FAKE_JAVA],
      cwd: DATA_DIR,
      env: {},
      onLine: (line) => lines.push(line.text),
      onExit: (code, signal) => exits.push({ code, signal }),
      onNotice: () => { /* not used here */ },
    });
    expect(connection).not.toBeNull();
    expect(connection!.adopted).toBe(false);
    await waitFor(() => lines.some((line) => line.includes("Done (")));
    expect(lines.some((line) => line.includes("fake java booting"))).toBe(true);
    // The pid the panel reports is the JVM's, not the relay's — metrics and cgroup attach need it.
    expect(connection!.pid).toBeGreaterThan(0);
    expect(connection!.pid).not.toBe(connection!.state.relayPid);
  }, 30_000);

  test("accepts console input", async () => {
    connection!.stdin!.write("list\n");
    await waitFor(() => lines.some((line) => line.includes("[echo] list")));
  }, 20_000);

  test("keeps the server alive when the panel disconnects", async () => {
    const javaPid = connection!.pid!;
    // Exactly what handOffForPanelRestart() does before the panel process exits.
    connection!.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(alive(javaPid)).toBe(true);
    expect(exits.length).toBe(0);
  }, 20_000);

  test("a new panel process reattaches with the console and stdin intact", async () => {
    const adoptedLines: string[] = [];
    const adoptedExits: Array<number | null> = [];
    connection = await relayClient.attachRelay(4242, "test-uuid", {
      onLine: (line) => adoptedLines.push(line.text),
      onExit: (code) => adoptedExits.push(code),
      onNotice: () => { /* ignore */ },
    });
    expect(connection).not.toBeNull();
    expect(connection!.adopted).toBe(true);
    // The backlog means the console is not blank after a restart.
    await waitFor(() => adoptedLines.length > 0);
    expect(adoptedLines.some((line) => line.includes("fake java booting"))).toBe(true);

    connection!.stdin!.write("say still here\n");
    await waitFor(() => adoptedLines.some((line) => line.includes("[echo] say still here")));
  }, 25_000);

  test("the adopted connection reports a real exit", async () => {
    const adopted: Array<{ code: number | null }> = [];
    connection!.disconnect();
    const second = await relayClient.attachRelay(4242, "test-uuid", {
      onLine: () => { /* ignore */ },
      onExit: (code) => adopted.push({ code }),
      onNotice: () => { /* ignore */ },
    });
    expect(second).not.toBeNull();
    second!.stdin!.write("stop\n");
    await waitFor(() => adopted.length > 0, 20_000);
    expect(adopted[0]!.code).toBe(0);
    connection = second;
  }, 30_000);

  test("state files are cleaned up and a stale relay is never adopted", async () => {
    relayClient.cleanRelayFiles(4242);
    expect(relayClient.readRelayState(4242)).toBeNull();
    const missing = await relayClient.attachRelay(9999, "nope", {
      onLine: () => { /* ignore */ },
      onExit: () => { /* ignore */ },
    });
    expect(missing).toBeNull();
  }, 15_000);

  test("a relay whose process died is not adopted", async () => {
    // Hand-write a state file pointing at a pid that certainly is not running.
    const state = {
      serverId: 4243, uuid: "dead", port: 9, token: "x".repeat(64), relayPid: 999_999,
      javaPid: null, startedAt: Date.now(), relayStartedAt: Date.now(), cwd: DATA_DIR,
      logPath: join(DATA_DIR, "dead.log"), seq: 0,
    };
    writeFileSync(relayClient.relayStatePath(4243), JSON.stringify(state));
    const adopted = await relayClient.attachRelay(4243, "dead", {
      onLine: () => { /* ignore */ },
      onExit: () => { /* ignore */ },
    });
    expect(adopted).toBeNull();
    expect(relayClient.readRelayState(4243)).toBeNull();
  }, 15_000);
});

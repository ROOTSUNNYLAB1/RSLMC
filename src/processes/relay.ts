/**
 * Server relay — the tiny detached process that owns one Minecraft JVM.
 *
 * Why it exists: the panel used to be the JVM's parent. Restarting the panel (an update, a crash,
 * `bun --watch` reloading) therefore left the JVM with no console: stdout went nowhere and stdin was
 * gone, so "stop" had to be replaced by "force kill". The relay fixes that by sitting between the two:
 *
 *     panel ──TCP (loopback, token)──▶ relay ──pipes──▶ java
 *
 * The relay is started detached, in its own process group, so it survives the panel exiting. It keeps
 * a ring buffer of console output and appends every line to a log file, then a *new* panel process
 * reconnects to it and gets the console back — live output, command input and the real exit code —
 * without the server ever being stopped.
 *
 * Security posture:
 *  - it listens on 127.0.0.1 only, on a random port;
 *  - the handshake needs a 32-byte random token that only the panel's data directory can read
 *    (state file mode 0600);
 *  - it accepts one client at a time and never executes anything the client sends — only the strings
 *    that are forwarded to the JVM's stdin, exactly like the panel's console did before.
 *
 * This file is an entry point (`bun src/processes/relay.ts <plan.json>`), not a library.
 */

import { createServer, type Socket } from "node:net";
import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface RelayPlan {
  serverId: number;
  uuid: string;
  command: string[];
  cwd: string;
  env: Record<string, string>;
  statePath: string;
  logPath: string;
  token: string;
  startedAt: number;
}

interface RelayLine {
  seq: number;
  ts: number;
  stream: "stdout" | "stderr" | "system";
  text: string;
}

const BACKLOG = 2000;
const MAX_LINE = 8000;

function readPlan(path: string): RelayPlan {
  const plan = JSON.parse(readFileSync(path, "utf8")) as RelayPlan;
  if (!Array.isArray(plan.command) || plan.command.length === 0) throw new Error("relay plan has no command");
  if (!plan.token || plan.token.length < 32) throw new Error("relay plan has no token");
  return plan;
}

function main(): void {
  const plan = readPlan(process.argv[2] ?? "");
  const backlog: RelayLine[] = [];
  let seq = 0;
  let client: Socket | null = null;
  let javaPid: number | null = null;
  let finished = false;

  mkdirSync(dirname(plan.statePath), { recursive: true });
  try { mkdirSync(dirname(plan.logPath), { recursive: true }); } catch { /* exists */ }

  const appendLog = (line: RelayLine) => {
    const stamp = new Date(line.ts).toISOString();
    try { appendFileSync(plan.logPath, `[${stamp}] ${line.stream === "stderr" ? "!" : " "} ${line.text}\n`); }
    catch { /* disk full: the panel still gets the live stream */ }
  };

  const push = (stream: RelayLine["stream"], text: string) => {
    const trimmed = text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}…` : text;
    const line: RelayLine = { seq: ++seq, ts: Date.now(), stream, text: trimmed };
    backlog.push(line);
    if (backlog.length > BACKLOG) backlog.splice(0, backlog.length - BACKLOG);
    appendLog(line);
    send({ type: "out", line });
  };

  const send = (payload: unknown) => {
    if (!client || client.destroyed) return;
    try { client.write(`${JSON.stringify(payload)}\n`); } catch { /* client vanished */ }
  };

  const writeState = (patch: Record<string, unknown>) => {
    try {
      const current = JSON.parse(readFileSync(plan.statePath, "utf8")) as Record<string, unknown>;
      const next = { ...current, ...patch, updatedAt: Date.now() };
      const tmp = `${plan.statePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
      renameSync(tmp, plan.statePath);
    } catch { /* the panel will simply see a stale state file and fall back to adoption */ }
  };

  const await0 = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(plan.command, {
      cwd: plan.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...plan.env },
      onExit(_p, exitCode, signalCode) {
        finish(exitCode ?? null, signalCode === null ? null : String(signalCode));
      },
    });
  } catch (error) {
    writeState({ exitCode: null, exitAt: Date.now(), failed: `Could not start Java: ${error instanceof Error ? error.message : String(error)}` });
    process.exit(1);
  }
  javaPid = proc.pid ?? null;

  const streamReader = (stream: "stdout" | "stderr", readable: ReadableStream<Uint8Array> | undefined) => {
    if (!readable) return;
    (async () => {
      const reader = readable.getReader();
      const decoder = new TextDecoder();
      let partial = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          partial += decoder.decode(value, { stream: true });
          const lines = partial.split(/\r?\n/);
          partial = lines.pop() ?? "";
          for (const line of lines) if (line.length > 0) push(stream, line);
        }
        if (partial.trim()) push(stream, partial);
      } catch { /* pipe closed */ }
    })();
  };
  streamReader("stdout", proc.stdout as ReadableStream<Uint8Array> | undefined);
  streamReader("stderr", proc.stderr as ReadableStream<Uint8Array> | undefined);

  function finish(exitCode: number | null, signal: string | null) {
    if (finished) return;
    finished = true;
    push("system", `Process exited (code ${exitCode ?? "signal"}${signal ? `, ${signal}` : ""}).`);
    writeState({ javaPid, exitCode, signal, exitAt: Date.now() });
    send({ type: "exit", code: exitCode, signal });
    // Give the socket a moment to flush, then leave. The state file is what the panel reads next boot.
    setTimeout(() => process.exit(0), 750);
  }

  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let authenticated = false;
    let buffered = "";
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      let index = buffered.indexOf("\n");
      while (index !== -1) {
        const raw = buffered.slice(0, index);
        buffered = buffered.slice(index + 1);
        index = buffered.indexOf("\n");
        let message: any;
        try { message = JSON.parse(raw); } catch { socket.destroy(); return; }
        if (!authenticated) {
          if (message?.type !== "hello" || message?.token !== plan.token) { socket.destroy(); return; }
          authenticated = true;
          client = socket;
          const since = Number(message.since ?? 0);
          send({ type: "ready", javaPid, startedAt: plan.startedAt, relayPid: process.pid, serverId: plan.serverId });
          const replay = backlog.filter((line) => line.seq > since);
          if (replay.length > 0) send({ type: "backlog", lines: replay });
          continue;
        }
        switch (message?.type) {
          case "stdin": {
            if (typeof message.data !== "string") break;
            const sink = proc.stdin as import("bun").FileSink | undefined;
            if (!sink) break;
            sink.write(message.data.endsWith("\n") ? message.data : `${message.data}\n`);
            sink.flush();
            break;
          }
          case "signal": {
            const pid = javaPid;
            const name = typeof message.signal === "string" ? message.signal : "SIGTERM";
            if (pid) { try { process.kill(pid, name as NodeJS.Signals); } catch { /* already gone */ } }
            break;
          }
          case "kill-tree": {
            const pid = javaPid;
            if (!pid) break;
            try {
              const alive = (value: number) => { try { process.kill(value, 0); return true; } catch { return false; } };
              const children = Bun.spawnSync(["sh", "-c", `ps -o pid= --ppid ${Number(pid)} 2>/dev/null`]);
              const pids = children.stdout.toString().split("\n").map((value) => value.trim()).filter((value) => /^\d+$/.test(value)).map(Number);
              for (const child of pids.reverse()) { try { process.kill(child, "SIGTERM"); } catch { /* ignore */ } }
              process.kill(pid, "SIGTERM");
              await0(1500).then(() => {
                for (const child of pids.reverse()) { try { process.kill(child, "SIGKILL"); } catch { /* ignore */ } }
                try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
                if (alive(pid)) send({ type: "kill-failed", pid });
              });
            } catch { /* ignore */ }
            break;
          }
          case "ping":
            send({ type: "pong" });
            break;
          default:
            break;
        }
      }
    });
    socket.on("error", () => { if (client === socket) client = null; });
    socket.on("close", () => { if (client === socket) client = null; });
  });

  server.on("error", (error) => {
    writeState({ relayError: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });

  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const state = {
      serverId: plan.serverId,
      uuid: plan.uuid,
      port,
      token: plan.token,
      relayPid: process.pid,
      javaPid,
      startedAt: plan.startedAt,
      relayStartedAt: Date.now(),
      cwd: plan.cwd,
      logPath: plan.logPath,
      seq,
    };
    const tmp = `${plan.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, plan.statePath);
    push("system", `Relay ready on 127.0.0.1:${port} (java pid ${javaPid ?? "?"}). The server survives a panel restart.`);
  });

  // If the JVM disappears without an exit event (killed externally), make sure the state file says so.
  setInterval(() => {
    if (finished || !javaPid) return;
    try { process.kill(javaPid, 0); }
    catch { finish(null, "vanished"); }
  }, 5000).unref?.();

  const shutdownRelay = () => {
    // The panel asked us to go away (panel shutdown with servers stopped deliberately).
    writeState({ relayStoppedAt: Date.now() });
    try { if (javaPid) process.kill(javaPid, "SIGTERM"); } catch { /* ignore */ }
    setTimeout(() => process.exit(0), 250);
  };
  process.on("SIGTERM", shutdownRelay);
  process.on("SIGINT", shutdownRelay);
}

main();

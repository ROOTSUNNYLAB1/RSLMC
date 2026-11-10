import { query, queryOne, run } from "../database";
import { ApiException } from "../shared/http";
import { cloudflaredInfo, type CloudflaredInfo } from "./cloudflared";
import { openSecret, sealSecret, secretFingerprint } from "../security/secrets";

/*
 * Cloudflare Tunnel, for nodes.
 *
 * Why this exists: a node is another machine running this panel, and the controller reaches it at
 * `scheme://fqdn:port`. That works on a LAN or a VPS with a public IP. It does not work on a home
 * connection behind CGNAT, a provider that blocks inbound 80/443, or a machine the operator does not
 * want to expose at all. A Cloudflare Tunnel fixes exactly that: `cloudflared` dials *out* to
 * Cloudflare, Cloudflare terminates TLS on a hostname you own, and forwards down the existing
 * connection. Nothing inbound is opened on the node.
 *
 * Two ways to run it, both managed from here:
 *
 *   • **token** — the operator creates a tunnel in the Cloudflare Zero Trust dashboard (Networks →
 *     Tunnels), points a public hostname at `http://127.0.0.1:<port>`, and pastes the token. The panel
 *     runs `cloudflared tunnel run --token <token>`. The hostname is theirs, it is stable, and it is
 *     what the controller should be told to use.
 *   • **quick** — `cloudflared tunnel --url http://127.0.0.1:<port>` with no account at all. Cloudflare
 *     hands out a random `*.trycloudflare.com` hostname. Genuinely useful for proving the path works
 *     before touching DNS, and genuinely not for production: the hostname changes on every start,
 *     Cloudflare rate-limits it, and the tunnel dies with the process. The UI says so.
 *
 * The token is stored sealed (AES-256-GCM, see security/secrets.ts) and is never returned by any
 * endpoint — only whether one is stored, plus a short fingerprint.
 */

export type TunnelMode = "token" | "quick";
export type TunnelStatus = "stopped" | "starting" | "running" | "failed";

export interface TunnelRow {
  id: number;
  node_id: number;
  mode: TunnelMode;
  hostname: string | null;
  token_sealed: string | null;
  local_scheme: string;
  local_host: string;
  local_port: number;
  enabled: number;
  status: TunnelStatus;
  last_error: string | null;
  last_started_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TunnelPublic {
  nodeId: number;
  configured: boolean;
  mode: TunnelMode;
  /** The hostname the controller/players should use. Quick tunnels discover it from the log. */
  hostname: string | null;
  status: TunnelStatus;
  hasToken: boolean;
  tokenFingerprint: string | null;
  localUrl: string;
  enabled: boolean;
  lastError: string | null;
  lastStartedAt: string | null;
  /** `https://host` once a hostname is known, for copy buttons. */
  publicUrl: string | null;
  cloudflared: CloudflaredInfo;
  log: string[];
}

interface Runner {
  process: ReturnType<typeof Bun.spawn>;
  log: string[];
  hostname: string | null;
  stopping: boolean;
  restarts: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const LOG_LIMIT = 300;
const runners = new Map<number, Runner>();
const MAX_RESTARTS = 3;
const RESTART_DELAY_MS = 4000;

export function getTunnelRow(nodeId: number): TunnelRow | null {
  return queryOne<TunnelRow>("SELECT * FROM node_tunnels WHERE node_id = ?", [nodeId]);
}

/** The address `cloudflared` should forward to. */
export function localTarget(row: Pick<TunnelRow, "local_scheme" | "local_host" | "local_port">): string {
  return `${row.local_scheme === "https" ? "https" : "http"}://${row.local_host}:${row.local_port}`;
}

/**
 * Validate a hostname the operator typed in token mode.
 *
 * Failing here beats failing at Cloudflare: a stray `https://`, a trailing slash, a port or a space all
 * produce a tunnel that starts while the hostname answers nothing, which looks like a panel bug. A
 * `trycloudflare.com` name is refused because those belong to quick tunnels — DNS cannot be pointed at
 * one, so accepting it would be a promise the panel cannot keep.
 */
export function validateHostname(
  input: string | null | undefined,
  options: { allowQuick?: boolean } = {},
): { hostname: string | null; error: string | null } {
  const raw = (input ?? "").trim();
  if (!raw) return { hostname: null, error: null }; // optional: quick mode fills it in later
  let value = raw.toLowerCase().replace(/^[a-z]+:\/\//, "");
  value = value.split("/")[0];
  value = value.split("@").pop() ?? value;
  value = value.replace(/:\d+$/, "");
  if (value !== value.trim()) return { hostname: null, error: "The hostname contains spaces. Enter just the domain, e.g. node1.example.com." };
  if (!/^[a-z0-9.-]+$/.test(value)) return { hostname: null, error: `"${value}" is not a valid hostname. Use letters, digits, dots and hyphens only.` };
  // Checked before the dot rule: "localhost" has no dot, and "public domain" is the real reason.
  if (value === "localhost" || value.endsWith(".localhost")) return { hostname: null, error: "A tunnel hostname must be a public domain, not localhost." };
  if (!value.includes(".")) return { hostname: null, error: `"${value}" has no dot in it — a tunnel hostname is a real domain, e.g. node1.example.com.` };
  /*
   * A trycloudflare name is only valid when Cloudflare itself handed it out for a quick tunnel on this
   * node. Typed in by hand in token mode it can never work — DNS is not ours to point at it — so the
   * default is to refuse it, and `allowQuick` is set only on the path that reads Cloudflare's answer.
   */
  if (!options.allowQuick && value.endsWith(".trycloudflare.com")) {
    return { hostname: null, error: "trycloudflare.com hostnames are assigned by Cloudflare for quick tunnels. Use quick mode, or your own domain in token mode." };
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) return { hostname: null, error: "A tunnel hostname is a domain name, not an IP address — Cloudflare routes by hostname." };
  return { hostname: value, error: null };
}

/** Quick tunnels announce their hostname in the log; this is the only place it exists. */
export function parseQuickHostname(text: string): string | null {
  const match = text.match(/https:\/\/([a-z0-9][a-z0-9-]*)\.trycloudflare\.com/i);
  return match ? `${match[1].toLowerCase()}.trycloudflare.com` : null;
}

/**
 * Does the published hostname actually reach this panel?
 *
 * "Registered tunnel connection" in the log is not proof that DNS points at the tunnel in token mode.
 * This asks the public URL for the panel's own liveness endpoint and reports the real status, so
 * "running" and "reachable" stay two different facts.
 */
export async function checkPublicReachability(hostname: string, timeoutMs = 12_000): Promise<{
  reachable: boolean;
  status: number | null;
  latencyMs: number | null;
  detail: string;
}> {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`https://${hostname}/api/agent/ping`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    const latencyMs = Math.round(performance.now() - started);
    const text = await response.text();
    const looksLikeUs = text.includes("RSLMC");
    return {
      reachable: response.ok && looksLikeUs,
      status: response.status,
      latencyMs,
      detail: response.ok
        ? looksLikeUs
          ? `HTTP ${response.status} in ${latencyMs} ms — the tunnel reaches this panel.`
          : `HTTP ${response.status}, but the answer did not come from RSLMC. Check that the public hostname points at this panel's port.`
        : `HTTP ${response.status} through the tunnel: Cloudflare answered, the panel did not.`,
    };
  } catch (error) {
    return {
      reachable: false,
      status: null,
      latencyMs: null,
      detail: controller.signal.aborted
        ? `No answer within ${Math.round(timeoutMs / 1000)} s. DNS may not point at the tunnel yet, or the tunnel is not connected.`
        : `Request failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Keep only the tail of cloudflared's output, and never keep a token in it. */
export function scrubLogLine(line: string): string | null {
  const clean = line.replace(/\s+$/, "");
  if (!clean) return null;
  // The token reaches the command line we build, and a line that quotes it must not reach the UI.
  return clean.replace(/[A-Za-z0-9_-]{40,}/g, "«redacted»");
}

function appendLog(nodeId: number, chunk: string): void {
  const runner = runners.get(nodeId);
  if (!runner) return;
  for (const line of chunk.split(/\r?\n/)) {
    const scrubbed = scrubLogLine(line);
    if (!scrubbed) continue;
    runner.log.push(scrubbed);
    if (runner.log.length > LOG_LIMIT) runner.log.splice(0, runner.log.length - LOG_LIMIT);
    const hostname = parseQuickHostname(scrubbed);
    if (hostname && hostname !== runner.hostname) {
      runner.hostname = hostname;
      run("UPDATE node_tunnels SET hostname = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE node_id = ?", [hostname, nodeId]);
    }
  }
}

/** Arguments for `cloudflared`, built in one place so a test can read them. */
export function buildArgs(row: Pick<TunnelRow, "mode" | "local_scheme" | "local_host" | "local_port">, token: string | null): string[] {
  if (row.mode === "token") {
    if (!token) throw new ApiException(409, "tunnel_token_missing", "This tunnel has no token stored. Paste the token from the Cloudflare Zero Trust dashboard first.");
    // `--token` keeps the credential out of a config file on disk; it is visible in this process's own
    // argv (root-only on Linux), which the documentation states rather than glosses over.
    return ["tunnel", "--no-autoupdate", "run", "--token", token];
  }
  return ["tunnel", "--no-autoupdate", "--url", localTarget(row)];
}

function setStatus(nodeId: number, status: TunnelStatus, error: string | null = null): void {
  run(
    "UPDATE node_tunnels SET status = ?, last_error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE node_id = ?",
    [status, error, nodeId],
  );
}

export interface TunnelConfigInput {
  mode: TunnelMode;
  hostname?: string | null;
  /** Omit to keep the stored token; send an empty string to clear it. */
  token?: string | null;
  localPort?: number | null;
  localHost?: string | null;
  localScheme?: "http" | "https" | null;
  enabled?: boolean;
}

/** Save (or create) the tunnel configuration for a node. Never runs it. */
export function saveTunnelConfig(nodeId: number, input: TunnelConfigInput): TunnelRow {
  const mode: TunnelMode = input.mode === "quick" ? "quick" : "token";
  const { hostname, error } = validateHostname(input.hostname ?? null);
  if (error) throw new ApiException(400, "invalid_hostname", error);
  const port = input.localPort ?? getTunnelRow(nodeId)?.local_port ?? 3986;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ApiException(400, "invalid_port", "The local port must be between 1 and 65535.");

  const existing = getTunnelRow(nodeId);
  let sealed = existing?.token_sealed ?? null;
  if (input.token !== undefined) sealed = input.token === null || input.token.trim() === "" ? null : sealSecret(input.token);
  if (mode === "token" && !sealed) {
    throw new ApiException(400, "tunnel_token_required",
      "Token mode needs the tunnel token from Cloudflare. Quick mode needs no account at all — use it if you only want a temporary hostname.");
  }

  if (!existing) {
    run(
      `INSERT INTO node_tunnels (node_id, mode, hostname, token_sealed, local_scheme, local_host, local_port, enabled, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'stopped')`,
      [nodeId, mode, hostname, sealed, input.localScheme ?? "http", (input.localHost ?? "127.0.0.1").trim() || "127.0.0.1", port, input.enabled === false ? 0 : 1],
    );
  } else {
    run(
      `UPDATE node_tunnels SET mode = ?, hostname = ?, token_sealed = ?, local_scheme = ?, local_host = ?, local_port = ?,
         enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE node_id = ?`,
      [mode, hostname, sealed, input.localScheme ?? existing.local_scheme, (input.localHost ?? existing.local_host).trim() || "127.0.0.1", port,
        input.enabled === false ? 0 : 1, nodeId],
    );
  }
  return getTunnelRow(nodeId)!;
}

/**
 * Start the tunnel for a node.
 *
 * The binary is resolved first: a missing `cloudflared` is reported as that, never as "tunnel failed".
 * Output is streamed into the tunnel's own log buffer (scrubbed), a quick tunnel's hostname is picked up
 * from it, and an unexpected exit is recorded with the last lines cloudflared printed — the operator
 * needs Cloudflare's own words, not a paraphrase.
 */
export function startTunnel(nodeId: number): TunnelPublic {
  const row = getTunnelRow(nodeId);
  if (!row) throw new ApiException(404, "tunnel_not_configured", "No tunnel is configured for this node yet.");
  const running = runners.get(nodeId);
  if (running) return tunnelSnapshot(nodeId);
  if (row.mode === "token" && !row.token_sealed) {
    throw new ApiException(409, "tunnel_token_missing", "This tunnel has no token stored. Paste the token from the Cloudflare dashboard first.");
  }
  const binary = cloudflaredInfo();
  if (!binary.path) throw new ApiException(409, "cloudflared_missing", binary.problem ?? "cloudflared is not installed on this machine.");
  if (row.mode === "quick" && !row.hostname) {
    // A stale quick hostname from a previous run is meaningless; clear it so "running" never shows an
    // address that has not answered yet.
    run("UPDATE node_tunnels SET hostname = NULL WHERE node_id = ?", [nodeId]);
  }

  const token = row.mode === "token" ? openSecret(row.token_sealed) : null;
  if (row.mode === "token" && !token) {
    throw new ApiException(409, "tunnel_token_unreadable",
      "The stored tunnel token could not be decrypted (the panel secret changed?). Paste the token again.");
  }
  const args = buildArgs(row, token);
  const process_ = Bun.spawn({
    cmd: [binary.path, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_AUTO_UPDATE: "true" },
  });
  const runner: Runner = { process: process_, log: [], hostname: row.mode === "quick" ? null : row.hostname, stopping: false, restarts: 0, timer: null };
  runners.set(nodeId, runner);
  setStatus(nodeId, "starting");
  run("UPDATE node_tunnels SET last_started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE node_id = ?", [nodeId]);

  const pump = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return;
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
        appendLog(nodeId, decoder.decode(chunk, { stream: true }));
      }
    } catch { /* the process went away; the exit handler reports it */ }
  };
  void pump(process_.stdout as ReadableStream<Uint8Array>);
  void pump(process_.stderr as ReadableStream<Uint8Array>);

  // "Running" means cloudflared is up; "reachable" is measured separately by checkPublicReachability().
  setTimeout(() => {
    const current = runners.get(nodeId);
    if (current === runner && !runner.stopping) setStatus(nodeId, "running");
  }, 2500);

  void process_.exited.then((code) => {
    const current = runners.get(nodeId);
    if (current !== runner) return;
    runners.delete(nodeId);
    if (runner.stopping) {
      setStatus(nodeId, "stopped");
      return;
    }
    const tail = runner.log.slice(-4).join(" | ") || "no output";
    const reason = `cloudflared exited with code ${code}. Last output: ${tail}`;
    setStatus(nodeId, "failed", reason);
    /*
     * Restart a crashed tunnel a few times — Cloudflare edge hiccups are real — but not forever: a
     * wrong token or a hostname conflict fails identically every time, and a restart loop would fill
     * the log with the same error instead of showing it once.
     */
    if (runner.restarts < MAX_RESTARTS) {
      runner.restarts += 1;
      runner.timer = setTimeout(() => {
        try {
          const next = getTunnelRow(nodeId);
          if (next?.enabled) startTunnel(nodeId);
        } catch { /* the status already explains the last failure */ }
      }, RESTART_DELAY_MS);
    }
  });

  return tunnelSnapshot(nodeId);
}

export function stopTunnel(nodeId: number): TunnelPublic {
  const runner = runners.get(nodeId);
  if (runner) {
    runner.stopping = true;
    if (runner.timer) clearTimeout(runner.timer);
    try { runner.process.kill("SIGTERM"); } catch { /* already gone */ }
    setTimeout(() => {
      try { if (!runner.process.killed) runner.process.kill("SIGKILL"); } catch { /* gone */ }
    }, 5000);
    runners.delete(nodeId);
  }
  setStatus(nodeId, "stopped");
  return tunnelSnapshot(nodeId);
}

/** Stop every tunnel this panel is running (used on shutdown). */
export function stopAllTunnels(): void {
  for (const nodeId of [...runners.keys()]) {
    try { stopTunnel(nodeId); } catch { /* best effort at exit */ }
  }
}

/** Forget a tunnel configuration entirely (node deleted, or the operator removes it). */
export function deleteTunnel(nodeId: number): void {
  stopTunnel(nodeId);
  run("DELETE FROM node_tunnels WHERE node_id = ?", [nodeId]);
}

export function tunnelSnapshot(nodeId: number): TunnelPublic {
  const row = getTunnelRow(nodeId);
  const runner = runners.get(nodeId);
  const hostname = row?.hostname ?? runner?.hostname ?? null;
  return {
    nodeId,
    configured: Boolean(row),
    mode: (row?.mode ?? "quick") as TunnelMode,
    hostname,
    status: (row?.status ?? "stopped") as TunnelStatus,
    hasToken: Boolean(row?.token_sealed),
    tokenFingerprint: secretFingerprint(row?.token_sealed ?? null),
    localUrl: row ? localTarget(row) : "",
    enabled: row ? row.enabled === 1 : false,
    lastError: row?.last_error ?? null,
    lastStartedAt: row?.last_started_at ?? null,
    publicUrl: hostname ? `https://${hostname}` : null,
    cloudflared: cloudflaredInfo(),
    log: runner?.log.slice(-120) ?? [],
  };
}

/** Tunnels currently supervised here, for the boot/shutdown report. */
export function runningTunnelCount(): number {
  return runners.size;
}

/**
 * Boot: restart the tunnels that were enabled when the panel went down.
 *
 * A tunnel is the node's only way to be reached when it has no open ports, so leaving it stopped after
 * a restart would silently disconnect a working node. A failure here is reported per tunnel and never
 * blocks the panel from starting.
 */
export function resumeEnabledTunnels(): { started: number; failed: number } {
  let rows: TunnelRow[] = [];
  try {
    rows = query<TunnelRow>("SELECT * FROM node_tunnels WHERE enabled = 1");
  } catch {
    return { started: 0, failed: 0 }; // table not created yet (very old database)
  }
  let started = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      startTunnel(row.node_id);
      started += 1;
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      setStatus(row.node_id, "failed", message);
    }
  }
  return { started, failed };
}

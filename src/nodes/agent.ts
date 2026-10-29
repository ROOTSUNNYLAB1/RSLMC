import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getSetting, setSetting, query, queryOne, run } from "../database";
import { APP_VERSION, MODE, PORT, hostPlatform, loadAppSecret } from "../shared/config";
import { hostname } from "node:os";
import { ALL_PERMISSIONS } from "../shared/permissions";
import type { UserPublic } from "../shared/types";
import { hostStats } from "../resources/host";
import { detectCgroups } from "../resources/cgroups";

/**
 * Node side of multi-node support.
 *
 * A node is an ordinary RSLMC installation that has been given an *agent key* by a controller panel.
 * Requests carrying `Authorization: Bearer <key>` are treated as coming from that controller, which
 * means they run with the controller's authority — the controller is where users, roles and server
 * ownership actually live, so it does the RBAC check before forwarding anything.
 *
 * Consequences that are deliberate, not accidental:
 *  - The key is stored only on the node, hashed with HMAC-SHA256 over the panel's own secret. There is
 *    no way to recover it, and it can be rotated from either side at any time.
 *  - A node with no key configured is *not* a node: every bearer request is ignored and the panel
 *    behaves exactly as a stand-alone install.
 *  - The key is never written to the database in clear, never logged, and never returned by any API
 *    after it is set (only a short fingerprint, so an operator can tell two keys apart).
 */

const KEY_SETTING = "node.agent_key_hash";
const FINGERPRINT_SETTING = "node.agent_key_fingerprint";
const LABEL_SETTING = "node.controller_label";
const ACCEPTED_SETTING = "node.agent_requests_accepted";

function fingerprint(key: string): string {
  return createHmac("sha256", "rslmc-node-fingerprint").update(key).digest("hex").slice(0, 12);
}

let cachedSecret: string | null = null;
function panelSecret(): string {
  // Keyed with the panel secret so a dumped database alone cannot be brute-forced offline.
  if (!cachedSecret) cachedSecret = loadAppSecret();
  return cachedSecret;
}

function hashKey(key: string): string {
  return createHmac("sha256", panelSecret()).update(`node-agent:${key}`).digest("hex");
}

export interface NodeSelfState {
  enabled: boolean;
  fingerprint: string | null;
  controllerLabel: string | null;
  requestsAccepted: number;
  panelVersion: string;
  port: number;
  mode: string;
  os: string;
  arch: string;
}

export function nodeSelfState(): NodeSelfState {
  const fingerprintValue = getSetting(FINGERPRINT_SETTING, null);
  return {
    enabled: Boolean(getSetting(KEY_SETTING, null)),
    fingerprint: fingerprintValue,
    controllerLabel: getSetting(LABEL_SETTING, null),
    requestsAccepted: Number(getSetting(ACCEPTED_SETTING, "0") ?? 0),
    panelVersion: APP_VERSION,
    port: PORT,
    mode: MODE,
    os: hostPlatform().os,
    arch: hostPlatform().arch,
  };
}

/** Sets (or replaces) this panel's agent key. Called from the node's own admin UI or the CLI. */
export function setAgentKey(key: string, label: string | null = null): { fingerprint: string } {
  const trimmed = key.trim();
  if (trimmed.length < 24) throw new Error("An agent key must be at least 24 characters.");
  setSetting(KEY_SETTING, hashKey(trimmed), true);
  setSetting(FINGERPRINT_SETTING, fingerprint(trimmed));
  if (label !== null) setSetting(LABEL_SETTING, label.slice(0, 120));
  recordAgentEvent("key.set", label ? `controller: ${label}` : null);
  return { fingerprint: fingerprint(trimmed) };
}

export function clearAgentKey(): void {
  run("DELETE FROM settings WHERE key IN (?, ?, ?)", [KEY_SETTING, FINGERPRINT_SETTING, LABEL_SETTING]);
  recordAgentEvent("key.cleared", null);
}

/** True when `token` is this panel's agent key. Constant-time, and false when no key is configured. */
export function isAgentKey(token: string | null | undefined): boolean {
  if (!token) return false;
  const stored = getSetting(KEY_SETTING, null);
  if (!stored) return false;
  const incoming = Buffer.from(hashKey(token), "hex");
  const expected = Buffer.from(stored, "hex");
  if (incoming.length !== expected.length) return false;
  return timingSafeEqual(incoming, expected);
}

/**
 * The identity a controller request runs as. It is root-equivalent **on the node** on purpose: the
 * node has no idea which of the controller's users made the request, and inventing a local user for
 * every controller account would make the two databases disagree. The controller enforces RBAC and
 * records the human behind the request in its own audit log.
 */
export function nodeControllerUser(): UserPublic {
  return {
    id: 0,
    username: "node-controller",
    email: null,
    isRoot: true,
    mustChangePassword: false,
    totpEnabled: false,
    disabled: false,
    roles: ["Node controller"],
    permissions: [...ALL_PERMISSIONS],
    createdAt: new Date(0).toISOString(),
    lastLoginAt: null,
    avatarColor: "#4ade80",
    avatarUrl: null,
  } as UserPublic;
}

export function recordAgentEvent(kind: string, detail: string | null): void {
  try { run("INSERT INTO node_agent_events (kind, detail) VALUES (?, ?)", [kind, detail]); } catch { /* table always exists after migration */ }
}

export function bumpAccepted(): void {
  const current = Number(getSetting(ACCEPTED_SETTING, "0") ?? 0);
  setSetting(ACCEPTED_SETTING, String(current + 1));
}

/** What a controller learns when it says hello. Everything here is measured, nothing is guessed. */
export interface HandshakePayload {
  apiVersion: number;
  panel: {
    version: string;
    mode: string;
    port: number;
    uptimeSeconds: number;
    bunVersion: string;
    os: string;
    arch: string;
    hostname: string;
  };
  node: {
    fingerprint: string | null;
    controllerLabel: string | null;
    requestsAccepted: number;
  };
  stats: ReturnType<typeof hostStats>;
  servers: { total: number; running: number };
}

export const NODE_API_VERSION = 1;

export function handshakePayload(): HandshakePayload {
  const stats = hostStats();
  // The controller shows these badges for every node, so report what is true on *this* machine.
  const cgroups = detectCgroups();
  stats.agents = { cgroups: cgroups.privileged, privileged: cgroups.privileged };
  const total = queryOne<{ c: number }>("SELECT COUNT(*) AS c FROM servers")?.c ?? 0;
  const running = queryOne<{ c: number }>(
    "SELECT COUNT(*) AS c FROM servers WHERE status IN ('online','starting','stopping','restarting')",
  )?.c ?? 0;
  const self = nodeSelfState();
  return {
    apiVersion: NODE_API_VERSION,
    panel: {
      version: APP_VERSION,
      mode: MODE,
      port: PORT,
      uptimeSeconds: Math.floor(process.uptime()),
      bunVersion: Bun.version,
      os: stats.os,
      arch: stats.arch,
      hostname: hostname(),
    },
    node: {
      fingerprint: self.fingerprint,
      controllerLabel: self.controllerLabel,
      requestsAccepted: self.requestsAccepted,
    },
    stats,
    servers: { total, running },
  };
}

/** Servers this node believes it hosts, for a controller that is reconciling its records. */
export function nodeServerInventory(): { id: number; uuid: string; name: string; status: string }[] {
  return query<{ id: number; uuid: string; name: string; status: string }>(
    "SELECT id, uuid, name, status FROM servers ORDER BY id",
  );
}

export function generateAgentKey(): string {
  return randomBytes(32).toString("base64url");
}

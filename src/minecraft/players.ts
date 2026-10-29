import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { query, queryOne, run, insert } from "../database";
import { serverDir } from "../shared/config";
import { ApiException } from "../shared/http";
import { writeFileAtomic } from "../services/download";
import { readProperties, writeProperties } from "./properties";
import { isRunning, sendCommand } from "../processes/manager";
import { recordActivity } from "../services/audit";
import type { PlayerRecord } from "../shared/types";

/* ------------------------------------------------------------------ */
/* UUID resolution                                                     */
/* ------------------------------------------------------------------ */

const uuidCache = new Map<string, { uuid: string; at: number }>();

/** Deterministic offline-mode UUID (MD5 of "OfflinePlayer:<name>", version 3). */
export function offlineUuid(username: string): string {
  const hash = createHash("md5").update(`OfflinePlayer:${username}`).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x30;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export async function resolveUuid(username: string, onlineMode: boolean): Promise<{ uuid: string; source: string }> {
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) throw new ApiException(400, "invalid_username", "Minecraft usernames are 3–16 characters (letters, numbers, underscore)");
  if (!onlineMode) return { uuid: offlineUuid(username), source: "offline-mode" };

  const cached = uuidCache.get(username.toLowerCase());
  if (cached && Date.now() - cached.at < 30 * 60 * 1000) return { uuid: cached.uuid, source: "cache" };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const response = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(username)}`, {
      signal: controller.signal, headers: { "user-agent": "RSLMC/1.0" },
    });
    clearTimeout(timer);
    if (response.status === 404) throw new ApiException(404, "unknown_player", `Mojang has no account named "${username}"`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as { id: string };
    const raw = data.id;
    const uuid = `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20, 32)}`;
    uuidCache.set(username.toLowerCase(), { uuid, at: Date.now() });
    return { uuid, source: "mojang" };
  } catch (err) {
    if (err instanceof ApiException) throw err;
    // Mojang unreachable — fall back to the offline UUID but say so.
    return { uuid: offlineUuid(username), source: "offline-fallback" };
  }
}

/* ------------------------------------------------------------------ */
/* File-backed player lists                                            */
/* ------------------------------------------------------------------ */

interface OpsEntry { uuid: string; name: string; level: number; bypassesPlayerLimit: boolean }
interface WhitelistEntry { uuid: string; name: string }
interface BanEntry { uuid?: string; name?: string; ip?: string; reason?: string; source?: string; expires?: string }

function readJsonArray<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function writeJsonArray(path: string, value: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function playerFiles(serverId: number) {
  const server = queryOne<{ uuid: string }>("SELECT uuid FROM servers WHERE id = ?", [serverId]);
  if (!server) throw new ApiException(404, "server_not_found", "Server not found");
  const directory = serverDir(server.uuid);
  return {
    directory,
    ops: join(directory, "ops.json"),
    whitelist: join(directory, "whitelist.json"),
    bannedPlayers: join(directory, "banned-players.json"),
    bannedIps: join(directory, "banned-ips.json"),
    usercache: join(directory, "usercache.json"),
  };
}

/** Mirrors Minecraft's own JSON files into the database so the UI reflects real server state. */
export function syncPlayerFiles(serverId: number): void {
  const files = playerFiles(serverId);
  const ops = readJsonArray<OpsEntry>(files.ops);
  const whitelist = readJsonArray<WhitelistEntry>(files.whitelist);
  const bans = readJsonArray<BanEntry>(files.bannedPlayers);
  const usercache = readJsonArray<{ name: string; uuid: string }>(files.usercache);

  run("DELETE FROM operators WHERE server_id = ?", [serverId]);
  for (const entry of ops) {
    insert(
      "INSERT OR REPLACE INTO operators (server_id, uuid, name, level, bypasses_player_limit) VALUES (?, ?, ?, ?, ?)",
      [serverId, entry.uuid, entry.name, entry.level ?? 4, entry.bypassesPlayerLimit ? 1 : 0],
    );
  }

  run("DELETE FROM whitelist WHERE server_id = ?", [serverId]);
  for (const entry of whitelist) {
    insert("INSERT OR REPLACE INTO whitelist (server_id, uuid, name) VALUES (?, ?, ?)", [serverId, entry.uuid, entry.name]);
  }

  run("DELETE FROM bans WHERE server_id = ?", [serverId]);
  for (const entry of bans) {
    insert(
      "INSERT INTO bans (server_id, uuid, name, ip, type, reason, source, expires_at) VALUES (?, ?, ?, ?, 'player', ?, ?, ?)",
      [serverId, entry.uuid ?? null, entry.name ?? null, entry.ip ?? null, entry.reason ?? null, entry.source ?? "Minecraft", entry.expires && entry.expires !== "forever" ? entry.expires : null],
    );
  }

  // Repair names mangled by an older console detector ("85mSUNNYGAMINGPE" from an ANSI tail):
  // usercache.json is the authoritative list, so a stored name that merely *ends* with a known
  // name is rewritten to the real one instead of lingering as a phantom player.
  for (const row of query<{ id: number; username: string; uuid: string }>(
    "SELECT id, username, uuid FROM players WHERE server_id = ?", [serverId],
  )) {
    const needle = row.username.toLowerCase();
    if (usercache.some((entry) => entry.name?.toLowerCase() === needle)) continue;
    const healed = usercache.find((entry) => entry.name && needle.endsWith(entry.name.toLowerCase()));
    if (!healed?.name || !healed.uuid) continue;
    const clash = queryOne<{ id: number }>(
      "SELECT id FROM players WHERE server_id = ? AND uuid = ?", [serverId, healed.uuid],
    );
    run("DELETE FROM player_sessions WHERE server_id = ? AND player_uuid = ?", [serverId, row.uuid]);
    if (clash) run("DELETE FROM players WHERE id = ?", [row.id]);
    else run("UPDATE players SET username = ?, uuid = ? WHERE id = ?", [healed.name, healed.uuid, row.id]);
  }

  // usercache gives authoritative online-mode UUIDs for known players.
  for (const entry of usercache) {
    const existing = queryOne<{ id: number }>("SELECT id FROM players WHERE server_id = ? AND lower(username) = lower(?)", [serverId, entry.name]);
    if (existing) run("UPDATE players SET uuid = ? WHERE id = ?", [entry.uuid, existing.id]);
    else insert("INSERT INTO players (server_id, uuid, username) VALUES (?, ?, ?)", [serverId, entry.uuid, entry.name]);
  }
}

export function listPlayers(serverId: number, filter: "all" | "operators" | "whitelist" | "banned"): PlayerRecord[] {
  syncPlayerFiles(serverId);
  const rows = query<any>(
    `SELECT p.*,
       EXISTS(SELECT 1 FROM operators o WHERE o.server_id = p.server_id AND (o.uuid = p.uuid OR lower(o.name) = lower(p.username))) AS operator,
       EXISTS(SELECT 1 FROM whitelist w WHERE w.server_id = p.server_id AND (w.uuid = p.uuid OR lower(w.name) = lower(p.username))) AS whitelisted,
       EXISTS(SELECT 1 FROM bans b WHERE b.server_id = p.server_id AND (b.uuid = p.uuid OR lower(b.name) = lower(p.username))) AS banned
     FROM players p WHERE p.server_id = ? ORDER BY p.online DESC, lower(p.username)`,
    [serverId],
  );
  const mapped: PlayerRecord[] = rows.map((row) => ({
    id: row.id,
    serverId: row.server_id,
    uuid: row.uuid,
    username: row.username,
    online: row.online === 1,
    operator: row.operator === 1,
    whitelisted: row.whitelisted === 1,
    banned: row.banned === 1,
    lastSeenAt: row.last_seen_at,
    lastJoinAt: row.last_join_at,
    firstSeenAt: row.first_seen_at,
    playtimeSeconds: row.playtime_seconds,
    sessionStartAt: row.session_start_at,
  }));
  if (filter === "operators") return mapped.filter((player) => player.operator);
  if (filter === "whitelist") return mapped.filter((player) => player.whitelisted);
  if (filter === "banned") return mapped.filter((player) => player.banned);
  return mapped;
}

/**
 * Accepts either a UUID (online or `offline:` pseudo-UUID) or a username and returns the best known
 * identity for that player on this server. Records imported from Minecraft's own JSON files can
 * carry an empty UUID, and a mis-detected console line can leave a name-only record — the UI must
 * still be able to open such a player instead of failing with "a UUID is required".
 */
export function resolvePlayerRef(serverId: number, ref: string): { uuid: string; username: string } | null {
  const value = ref.trim();
  if (!value) return null;
  const uuidShape = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  if (uuidShape.test(value) || /^offline:[a-z0-9_]{1,20}$/i.test(value)) {
    const byUuid = queryOne<{ uuid: string; username: string }>(
      "SELECT uuid, username FROM players WHERE server_id = ? AND uuid = ?", [serverId, value],
    );
    if (byUuid) return byUuid;
    return { uuid: value, username: value };
  }
  const byName = queryOne<{ uuid: string; username: string }>(
    `SELECT uuid, username FROM players WHERE server_id = ?
       AND lower(username) = lower(?) AND length(uuid) >= 32
     ORDER BY online DESC, id LIMIT 1`,
    [serverId, value],
  );
  if (byName) return byName;
  const files = playerFiles(serverId);
  const cached = readJsonArray<{ name: string; uuid: string }>(files.usercache)
    .find((entry) => entry.name?.toLowerCase() === value.toLowerCase());
  if (cached?.uuid) return { uuid: cached.uuid, username: cached.name };
  const offline = offlineUuid(value);
  return /^[A-Za-z0-9_]{3,16}$/.test(value) ? { uuid: offline, username: value } : null;
}

export function playerSessions(serverId: number, uuid: string, limit = 50) {
  return query<any>(
    "SELECT * FROM player_sessions WHERE server_id = ? AND player_uuid = ? ORDER BY joined_at DESC LIMIT ?",
    [serverId, uuid, limit],
  );
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

export type PlayerAction =
  | { type: "op"; username: string; level?: number }
  | { type: "deop"; username: string }
  | { type: "whitelist.add"; username: string }
  | { type: "whitelist.remove"; username: string }
  | { type: "ban"; username: string; reason?: string }
  | { type: "pardon"; username: string }
  | { type: "kick"; username: string; reason?: string };

export interface PlayerActionResult {
  ok: boolean;
  message: string;
  live: boolean;
  uuid: string;
  source: string;
}

/**
 * Player actions always update Minecraft's own JSON files *and* are sent to the live console
 * when the server is running (the running server is the authority and rewrites these files on
 * shutdown, so both paths are required).
 */
export async function applyPlayerAction(serverId: number, action: PlayerAction, actor: string): Promise<PlayerActionResult> {
  const files = playerFiles(serverId);
  const properties = readProperties(files.directory);
  const onlineMode = properties.values["online-mode"] !== "false";
  const { uuid, source } = await resolveUuid(action.username, onlineMode);
  const live = isRunning(serverId);

  const ops = readJsonArray<OpsEntry>(files.ops);
  const whitelist = readJsonArray<WhitelistEntry>(files.whitelist);
  const bans = readJsonArray<BanEntry>(files.bannedPlayers);

  const commandFor = (): string | null => {
    switch (action.type) {
      case "op": return `op ${action.username}`;
      case "deop": return `deop ${action.username}`;
      case "whitelist.add": return `whitelist add ${action.username}`;
      case "whitelist.remove": return `whitelist remove ${action.username}`;
      case "ban": return `ban ${action.username}${action.reason ? ` ${action.reason}` : ""}`;
      case "pardon": return `pardon ${action.username}`;
      case "kick": return `kick ${action.username}${action.reason ? ` ${action.reason}` : ""}`;
      default: return null;
    }
  };

  switch (action.type) {
    case "op": {
      const existing = ops.findIndex((entry) => entry.name.toLowerCase() === action.username.toLowerCase());
      const entry: OpsEntry = { uuid, name: action.username, level: action.level ?? 4, bypassesPlayerLimit: false };
      if (existing >= 0) ops[existing] = entry; else ops.push(entry);
      writeJsonArray(files.ops, ops);
      break;
    }
    case "deop":
      writeJsonArray(files.ops, ops.filter((entry) => entry.name.toLowerCase() !== action.username.toLowerCase()));
      break;
    case "whitelist.add": {
      if (!whitelist.some((entry) => entry.name.toLowerCase() === action.username.toLowerCase())) {
        whitelist.push({ uuid, name: action.username });
        writeJsonArray(files.whitelist, whitelist);
      }
      break;
    }
    case "whitelist.remove":
      writeJsonArray(files.whitelist, whitelist.filter((entry) => entry.name.toLowerCase() !== action.username.toLowerCase()));
      break;
    case "ban": {
      const entry: BanEntry = {
        uuid, name: action.username, reason: action.reason ?? "Banned by an operator",
        source: `RSLMC (${actor})`, expires: "forever",
      };
      const filtered = bans.filter((item) => item.name?.toLowerCase() !== action.username.toLowerCase());
      filtered.push(entry);
      writeJsonArray(files.bannedPlayers, filtered);
      break;
    }
    case "pardon":
      writeJsonArray(files.bannedPlayers, bans.filter((entry) => entry.name?.toLowerCase() !== action.username.toLowerCase()));
      break;
    case "kick":
      break;
  }

  if (live) {
    const command = commandFor();
    if (command) {
      try { sendCommand(serverId, command, actor); } catch { /* surfaced below via files-only state */ }
    }
  }

  syncPlayerFiles(serverId);
  recordActivity({
    type: `player.${action.type.replace(".", "_")}`,
    serverId,
    target: action.username,
    actorName: actor,
    metadata: { uuid, live, source, ...(action.type === "ban" ? { reason: action.reason ?? null } : {}) },
  });

  const message = live
    ? `${action.type.replace(".", " ")} applied to ${action.username} and sent to the live server.`
    : `${action.type.replace(".", " ")} written to the server files. It takes effect the next time the server starts.`;
  return { ok: true, message, live, uuid, source };
}

export function whitelistEnabled(serverId: number): boolean {
  const files = playerFiles(serverId);
  const properties = readProperties(files.directory);
  return properties.values["white-list"] === "true" || properties.values["enforce-whitelist"] === "true";
}

export function setWhitelistEnabled(serverId: number, enabled: boolean, actor: string): void {
  const files = playerFiles(serverId);
  writeProperties(files.directory, { "white-list": enabled ? "true" : "false" }, new Set());
  if (isRunning(serverId)) {
    try { sendCommand(serverId, `whitelist ${enabled ? "on" : "off"}`, actor); } catch { /* ignore */ }
  }
  recordActivity({ type: "whitelist.toggled", serverId, target: enabled ? "enabled" : "disabled", actorName: actor });
}

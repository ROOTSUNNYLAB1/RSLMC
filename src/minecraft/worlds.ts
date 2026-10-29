import { existsSync, readdirSync, statSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { query, queryOne, run, insert } from "../database";
import { createBackup } from "../services/backups";
import { readWorldSeed } from "./nbt";
import { readProperties } from "./properties";
import { directorySizeSync } from "../resources/host";
import { ApiException } from "../shared/http";
import { serverDir } from "../shared/config";
import { writeFileAtomic } from "../services/download";
import type { WorldRecord } from "../shared/types";

interface DetectedWorld {
  name: string;
  folder: string;
  environment: "overworld" | "nether" | "end" | "custom";
  sizeBytes: number;
  seed: string | null;
  lastUpdated: string | null;
  dimensions: { nether: boolean; end: boolean };
}

/**
 * Detects worlds on disk. The Nether and End are *dimensions inside the main world folder*
 * (DIM-1 / DIM1) in vanilla Minecraft, so they are reported as dimensions rather than
 * separate folders — RSLMC does not pretend they can be deleted independently.
 */
export function detectWorlds(directory: string): DetectedWorld[] {
  if (!existsSync(directory)) return [];
  const properties = readProperties(directory);
  const mainWorld = properties.values["level-name"] || "world";
  const out: DetectedWorld[] = [];

  const candidates = new Set<string>();
  if (existsSync(join(directory, mainWorld, "level.dat"))) candidates.add(mainWorld);
  for (const entry of readdirSync(directory)) {
    if (entry.startsWith(".") || entry === "plugins" || entry === "mods" || entry === "libraries" || entry === "logs" || entry === "cache") continue;
    const full = join(directory, entry);
    try {
      if (statSync(full).isDirectory() && existsSync(join(full, "level.dat"))) candidates.add(entry);
    } catch { /* ignore */ }
  }

  for (const folder of candidates) {
    const full = join(directory, folder);
    const levelDat = join(full, "level.dat");
    const meta = readWorldSeed(levelDat);
    const nether = existsSync(join(full, "DIM-1")) || existsSync(join(full, "dimensions", "minecraft", "the_nether"));
    const end = existsSync(join(full, "DIM1")) || existsSync(join(full, "dimensions", "minecraft", "the_end"));
    out.push({
      name: folder === mainWorld ? folder : folder,
      folder,
      environment: "overworld",
      sizeBytes: directorySizeSync(full),
      seed: meta.seed,
      lastUpdated: meta.lastPlayed ? new Date(meta.lastPlayed).toISOString() : null,
      dimensions: { nether, end },
    });
  }
  return out;
}

/** Synchronises the worlds table with what is actually on disk. */
export function rediscoverWorlds(serverId: number): WorldRecord[] {
  const server = queryOne<{ uuid: string }>("SELECT uuid FROM servers WHERE id = ?", [serverId]);
  if (!server) throw new ApiException(404, "server_not_found", "Server not found");
  const directory = serverDir(server.uuid);
  const detected = detectWorlds(directory);
  const existing = query<{ folder: string; protected: number }>("SELECT folder, protected FROM worlds WHERE server_id = ?", [serverId]);
  const protectedFolders = new Set(existing.filter((row) => row.protected === 1).map((row) => row.folder));

  run("DELETE FROM worlds WHERE server_id = ?", [serverId]);
  for (const world of detected) {
    insert(
      `INSERT INTO worlds (server_id, name, folder, environment, size_bytes, seed, protected, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        serverId, world.name, world.folder, world.environment, world.sizeBytes, world.seed,
        protectedFolders.has(world.folder) ? 1 : 0, world.lastUpdated,
      ],
    );
  }
  const properties = readProperties(directory);
  const mainWorld = properties.values["level-name"] || "world";
  const main = queryOne<{ id: number; protected: number }>("SELECT id, protected FROM worlds WHERE server_id = ? AND folder = ?", [serverId, mainWorld]);
  if (main && main.protected === 0) run("UPDATE worlds SET protected = 1 WHERE id = ?", [main.id]);

  return query("SELECT * FROM worlds WHERE server_id = ? ORDER BY folder", [serverId]).map(mapWorld);
}

export function mapWorld(row: any): WorldRecord {
  return {
    id: row.id,
    serverId: row.server_id,
    name: row.name,
    folder: row.folder,
    environment: row.environment,
    sizeBytes: row.size_bytes,
    seed: row.seed,
    protected: row.protected === 1,
    lastUpdated: row.last_updated,
    detected: true,
  };
}

export function listWorlds(serverId: number): (WorldRecord & { dimensions?: { nether: boolean; end: boolean } })[] {
  const server = queryOne<{ uuid: string }>("SELECT uuid FROM servers WHERE id = ?", [serverId]);
  if (!server) return [];
  const detected = detectWorlds(serverDir(server.uuid));
  const rows = query("SELECT * FROM worlds WHERE server_id = ? ORDER BY folder", [serverId]).map(mapWorld);
  return rows.map((world) => {
    const match = detected.find((item) => item.folder === world.folder);
    return { ...world, sizeBytes: match?.sizeBytes ?? world.sizeBytes, seed: match?.seed ?? world.seed, dimensions: match?.dimensions };
  });
}

export function deleteWorld(serverId: number, worldId: number, opts: { confirmName: string; backupFirst: boolean }): void {
  const row = queryOne<any>("SELECT * FROM worlds WHERE id = ? AND server_id = ?", [worldId, serverId]);
  if (!row) throw new ApiException(404, "world_not_found", "World not found");
  if (row.protected === 1) throw new ApiException(409, "world_protected", "The primary world is protected. Disable protection explicitly before deleting it.");
  if (opts.confirmName !== row.folder) throw new ApiException(400, "confirm_mismatch", `Type "${row.folder}" to confirm deletion`);
  const server = queryOne<{ uuid: string }>("SELECT uuid FROM servers WHERE id = ?", [serverId])!;
  const path = join(serverDir(server.uuid), row.folder);
  if (opts.backupFirst) {
    createBackup(serverId, { name: `pre-delete-${row.folder}`, kind: "worlds", description: `Automatic backup before deleting ${row.folder}` });
  }
  rmSync(path, { recursive: true, force: true });
  run("DELETE FROM worlds WHERE id = ?", [worldId]);
}

export function renameWorld(serverId: number, worldId: number, newFolder: string): void {
  const row = queryOne<any>("SELECT * FROM worlds WHERE id = ? AND server_id = ?", [worldId, serverId]);
  if (!row) throw new ApiException(404, "world_not_found", "World not found");
  if (row.protected === 1) throw new ApiException(409, "world_protected", "Rename the primary world from server.properties (level-name) instead.");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(newFolder)) throw new ApiException(400, "invalid_name", "World folder names may contain letters, numbers, - and _");
  const server = queryOne<{ uuid: string }>("SELECT uuid FROM servers WHERE id = ?", [serverId])!;
  const base = serverDir(server.uuid);
  if (existsSync(join(base, newFolder))) throw new ApiException(409, "exists", "A folder with that name already exists");
  renameSync(join(base, row.folder), join(base, newFolder));
  run("UPDATE worlds SET folder = ?, name = ? WHERE id = ?", [newFolder, newFolder, worldId]);
}

export function createEmptyWorld(serverId: number, folder: string, seed: string | null): WorldRecord {
  const server = queryOne<{ uuid: string }>("SELECT uuid FROM servers WHERE id = ?", [serverId]);
  if (!server) throw new ApiException(404, "server_not_found", "Server not found");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(folder)) throw new ApiException(400, "invalid_name", "Invalid world folder name");
  const path = join(serverDir(server.uuid), folder);
  if (existsSync(path)) throw new ApiException(409, "exists", "That world folder already exists");
  mkdirSync(path, { recursive: true });
  writeFileAtomic(join(path, "README-rslmc.txt"), [
    "This folder was created by RSLMC.",
    seed ? `Requested seed: ${seed}` : "No seed was requested; the server will generate one.",
    "Minecraft will generate the actual level data the first time it loads this world.",
    "Add `level-name=" + folder + "` to server.properties (or use the World settings) to make it active.",
  ].join("\n"));
  insert(
    "INSERT INTO worlds (server_id, name, folder, environment, size_bytes, seed, protected) VALUES (?, ?, ?, 'overworld', 0, ?, 0)",
    [serverId, folder, folder, seed],
  );
  return mapWorld(queryOne("SELECT * FROM worlds WHERE server_id = ? AND folder = ?", [serverId, folder]));
}

export function worldPath(serverId: number, folder: string): string {
  const server = queryOne<{ uuid: string }>("SELECT uuid FROM servers WHERE id = ?", [serverId]);
  if (!server) throw new ApiException(404, "server_not_found", "Server not found");
  return join(serverDir(server.uuid), folder);
}

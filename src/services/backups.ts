import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { query, queryOne, run, insert } from "../database";
import { PATHS, serverDir, serverBackupDir } from "../shared/config";
import { ApiException } from "../shared/http";
import { isRunning, sendCommand } from "../processes/manager";
import { createTarGz, extractTarGz, isReadableArchive } from "../shared/archive";
import { recordActivity } from "./audit";
import { notify } from "./notifications";
import { bus, serverTopic } from "../events/bus";
import { getSetting, setSetting } from "../database";
import type { BackupRecord } from "../shared/types";

const running = new Set<number>();

function mapBackup(row: any): BackupRecord {
  return {
    id: row.id,
    uuid: row.uuid,
    serverId: row.server_id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    fileName: row.file_name,
    sizeBytes: row.size_bytes,
    status: row.status,
    sha256: row.sha256,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    createdBy: row.created_by,
    error: row.error,
  };
}

export function listBackups(serverId: number): BackupRecord[] {
  return query("SELECT * FROM backups WHERE server_id = ? ORDER BY id DESC", [serverId]).map(mapBackup);
}

async function hashFileSha256(path: string): Promise<string> {
  const hasher = createHash("sha256");
  for await (const chunk of Bun.file(path).stream() as any) hasher.update(chunk);
  return hasher.digest("hex");
}

function publishProgress(serverId: number, id: string, label: string, progress: number, total: number, done = false, error?: string) {
  bus.publish(serverTopic(serverId), {
    type: "progress", kind: "backup", id, progress, total, label, done, error,
  });
}

export interface CreateBackupOptions {
  name: string;
  description?: string;
  kind?: "full" | "worlds" | "config" | "plugins";
  actor?: string;
}

/**
 * Creates a real archive of the server directory using tar (available on Linux, macOS and
 * Windows 10+). Before archiving a running server, RSLMC flushes world data through the
 * console and disables auto-save so the archive is consistent.
 */
export async function createBackup(serverId: number, options: CreateBackupOptions): Promise<BackupRecord> {
  if (running.has(serverId)) throw new ApiException(409, "backup_in_progress", "A backup is already running for this server");
  const server = queryOne<{ uuid: string; name: string; software: string }>("SELECT uuid, name, software FROM servers WHERE id = ?", [serverId]);
  if (!server) throw new ApiException(404, "server_not_found", "Server not found");

  const directory = serverDir(server.uuid);
  if (!existsSync(directory)) throw new ApiException(400, "not_installed", "Server directory does not exist");

  const backupDir = serverBackupDir(server.uuid);
  mkdirSync(backupDir, { recursive: true });

  const uuid = randomUUID();
  const safeName = options.name.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60) || "backup";
  const fileName = `${safeName}-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`;
  const id = insert(
    `INSERT INTO backups (uuid, server_id, name, description, kind, file_name, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
    [uuid, serverId, options.name.slice(0, 120), options.description?.slice(0, 500) ?? null, options.kind ?? "full", fileName, options.actor ?? "system"],
  );
  const record = () => mapBackup(queryOne("SELECT * FROM backups WHERE id = ?", [id]));
  running.add(serverId);

  try {
    run("UPDATE backups SET status = 'running' WHERE id = ?", [id]);
    publishProgress(serverId, uuid, "Preparing backup", 0, 0);

    const live = isRunning(serverId);
    if (live) {
      try {
        sendCommand(serverId, "save-off", options.actor ?? "system");
        sendCommand(serverId, "save-all flush", options.actor ?? "system");
        await new Promise((resolve) => setTimeout(resolve, 2500));
      } catch { /* the archive is still taken; consistency is best effort */ }
    }

    const exclusions = options.kind === "full" ? ["cache", "logs/../cache"] : [];
    const pathsToArchive: string[] = [];
    if (options.kind === "worlds") {
      for (const row of query<{ folder: string }>("SELECT folder FROM worlds WHERE server_id = ?", [serverId])) {
        if (existsSync(join(directory, row.folder))) pathsToArchive.push(row.folder);
      }
      if (pathsToArchive.length === 0) pathsToArchive.push("world", "world_nether", "world_the_end");
      pathsToArchive.push("server.properties");
    } else if (options.kind === "config") {
      pathsToArchive.push("server.properties", "eula.txt", "ops.json", "whitelist.json", "banned-players.json", "banned-ips.json");
      if (existsSync(join(directory, "config"))) pathsToArchive.push("config");
    } else if (options.kind === "plugins") {
      if (existsSync(join(directory, "plugins"))) pathsToArchive.push("plugins");
      if (existsSync(join(directory, "mods"))) pathsToArchive.push("mods");
      if (existsSync(join(directory, "config"))) pathsToArchive.push("config");
    } else {
      pathsToArchive.push(".");
    }

    const archivePath = join(backupDir, fileName);
    publishProgress(serverId, uuid, "Compressing server files", 0, 0);
    try {
      createTarGz(archivePath, {
        cwd: directory,
        paths: pathsToArchive,
        exclude: exclusions.map((entry) => entry.replace(/^--exclude=?/, "")),
        onProgress: (done, total) => publishProgress(serverId, uuid, "Compressing server files", done, total),
      });
    } catch (error) {
      throw new ApiException(500, "backup_failed", `Archive creation failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500));
    }

    if (live) {
      try { sendCommand(serverId, "save-on", options.actor ?? "system"); } catch { /* ignore */ }
    }

    const sizeBytes = statSync(archivePath).size;
    publishProgress(serverId, uuid, "Verifying archive", sizeBytes, sizeBytes);
    if (!isReadableArchive(archivePath)) {
      rmSync(archivePath, { force: true });
      throw new ApiException(500, "backup_corrupt", "The archive failed its integrity check and was discarded");
    }
    const sha256 = await hashFileSha256(archivePath);

    run(
      `UPDATE backups SET status = 'completed', size_bytes = ?, sha256 = ?,
       completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      [sizeBytes, sha256, id],
    );
    publishProgress(serverId, uuid, "Backup complete", sizeBytes, sizeBytes, true);
    recordActivity({
      type: "backup.created", serverId, target: options.name, actorName: options.actor ?? "system",
      metadata: { sizeBytes, kind: options.kind ?? "full", file: fileName },
    });
    applyRetention(serverId);
    return record();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    run("UPDATE backups SET status = 'failed', error = ? WHERE id = ?", [message.slice(0, 500), id]);
    publishProgress(serverId, uuid, "Backup failed", 0, 0, true, message);
    notify({
      title: `Backup failed on ${server.name}`,
      body: message.slice(0, 300),
      severity: "error", kind: "backup_failed", link: `/servers/${serverId}/backups`,
    });
    throw err;
  } finally {
    running.delete(serverId);
  }
}

/** Deletes archives beyond the configured retention count (default 10). */
export function applyRetention(serverId: number): void {
  const keep = Number(getSetting("backups.retention", "10") ?? 10);
  const server = queryOne<{ uuid: string }>("SELECT uuid FROM servers WHERE id = ?", [serverId]);
  if (!server) return;
  const completed = query<any>(
    "SELECT * FROM backups WHERE server_id = ? AND status = 'completed' ORDER BY id DESC", [serverId],
  );
  for (const row of completed.slice(keep)) {
    rmSync(join(serverBackupDir(server.uuid), row.file_name), { force: true });
    run("DELETE FROM backups WHERE id = ?", [row.id]);
  }
}

export function deleteBackup(serverId: number, backupId: number, actor: string): void {
  const row = queryOne<any>("SELECT * FROM backups WHERE id = ? AND server_id = ?", [backupId, serverId]);
  if (!row) throw new ApiException(404, "backup_not_found", "Backup not found");
  const server = queryOne<{ uuid: string }>("SELECT uuid FROM servers WHERE id = ?", [serverId])!;
  rmSync(join(serverBackupDir(server.uuid), row.file_name), { force: true });
  run("DELETE FROM backups WHERE id = ?", [backupId]);
  recordActivity({ type: "backup.deleted", serverId, target: row.name, actorName: actor });
}

export function backupFilePath(serverId: number, backupId: number): { path: string; name: string; fileName: string } {
  const row = queryOne<any>("SELECT * FROM backups WHERE id = ? AND server_id = ?", [backupId, serverId]);
  if (!row) throw new ApiException(404, "backup_not_found", "Backup not found");
  const server = queryOne<{ uuid: string }>("SELECT uuid FROM servers WHERE id = ?", [serverId])!;
  const path = join(serverBackupDir(server.uuid), row.file_name);
  if (!existsSync(path)) throw new ApiException(404, "backup_missing", "The archive is missing from disk");
  return { path, name: row.name, fileName: row.file_name };
}

export async function verifyBackup(serverId: number, backupId: number): Promise<{ ok: boolean; message: string }> {
  const { path } = backupFilePath(serverId, backupId);
  const row = queryOne<any>("SELECT * FROM backups WHERE id = ?", [backupId])!;
  if (!isReadableArchive(path)) return { ok: false, message: "Archive is not readable" };
  if (row.sha256) {
    const actual = await hashFileSha256(path);
    if (actual !== row.sha256) return { ok: false, message: "Checksum does not match the stored value" };
  }
  return { ok: true, message: "Archive verified" };
}

/**
 * Restores an archive. The server must be stopped; the current directory is moved aside
 * (not deleted) so an interrupted restore can be rolled back.
 */
export async function restoreBackup(serverId: number, backupId: number, actor: string): Promise<{ restored: string; safetyPath: string }> {
  const row = queryOne<any>("SELECT * FROM backups WHERE id = ? AND server_id = ?", [backupId, serverId]);
  if (!row) throw new ApiException(404, "backup_not_found", "Backup not found");
  if (isRunning(serverId)) throw new ApiException(409, "server_running", "Stop the server before restoring a backup");
  if (row.status !== "completed") throw new ApiException(409, "backup_incomplete", "Only completed backups can be restored");

  const server = queryOne<{ uuid: string }>("SELECT uuid FROM servers WHERE id = ?", [serverId])!;
  const directory = serverDir(server.uuid);
  const archive = join(serverBackupDir(server.uuid), row.file_name);
  if (!existsSync(archive)) throw new ApiException(404, "backup_missing", "The archive is missing from disk");

  run("UPDATE backups SET status = 'restoring' WHERE id = ?", [backupId]);
  publishProgress(serverId, row.uuid, "Verifying archive", 0, 0);
  if (!isReadableArchive(archive)) {
    run("UPDATE backups SET status = 'completed' WHERE id = ?", [backupId]);
    throw new ApiException(500, "backup_corrupt", "Refusing to restore a corrupt archive");
  }

  const safetyPath = `${directory}.pre-restore-${Date.now()}`;
  if (existsSync(directory)) renameSync(directory, safetyPath);
  mkdirSync(directory, { recursive: true });

  publishProgress(serverId, row.uuid, "Extracting backup", 0, 0);
  try {
    extractTarGz(archive, directory);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    renameSync(safetyPath, directory);
    run("UPDATE backups SET status = 'completed' WHERE id = ?", [backupId]);
    throw new ApiException(500, "restore_failed", `Restore failed and the previous files were restored: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
  }

  run("UPDATE backups SET status = 'restored' WHERE id = ?", [backupId]);
  publishProgress(serverId, row.uuid, "Restore complete", 1, 1, true);
  recordActivity({
    type: "backup.restored", serverId, target: row.name, actorName: actor,
    metadata: { file: row.file_name, safetyPath },
  });
  return { restored: row.file_name, safetyPath };
}

export function backupStorageSummary(): { count: number; totalBytes: number; directory: string } {
  let totalBytes = 0;
  let count = 0;
  if (existsSync(PATHS.backups)) {
    for (const serverFolder of readdirSync(PATHS.backups)) {
      const full = join(PATHS.backups, serverFolder);
      try {
        if (!statSync(full).isDirectory()) continue;
        for (const file of readdirSync(full)) {
          count += 1;
          totalBytes += statSync(join(full, file)).size;
        }
      } catch { /* ignore */ }
    }
  }
  return { count, totalBytes, directory: PATHS.backups };
}

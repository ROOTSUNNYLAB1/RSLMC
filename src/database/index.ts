import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDirectories, PATHS, ROOT_DIR } from "../shared/config";

export type Row = Record<string, any>;

let db: Database | null = null;

export function getDb(): Database {
  if (db) return db;
  ensureDirectories();
  db = new Database(PATHS.dbFile, { create: true, readwrite: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  runMigrations(db);
  return db;
}

const MIGRATION_DIR = join(ROOT_DIR, "migrations");

export function runMigrations(connection: Database): { applied: string[]; current: number } {
  connection.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  const applied: string[] = [];
  const done = new Set(
    connection.query<{ version: number }, []>("SELECT version FROM schema_migrations").all().map((r) => r.version),
  );
  const files = readdirSync(MIGRATION_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const version = Number(file.split("_")[0]);
    if (!Number.isFinite(version) || done.has(version)) continue;
    const sql = readFileSync(join(MIGRATION_DIR, file), "utf8");
    const tx = connection.transaction(() => {
      connection.exec(sql);
      connection.run("INSERT INTO schema_migrations (version, name) VALUES (?, ?)", [version, file]);
    });
    tx();
    applied.push(file);
  }
  const current = connection.query<{ v: number }, []>("SELECT COALESCE(MAX(version),0) AS v FROM schema_migrations").get();
  return { applied, current: current?.v ?? 0 };
}

export function query<T = Row>(sql: string, params: any[] = []): T[] {
  return getDb().query(sql).all(...params) as T[];
}

export function queryOne<T = Row>(sql: string, params: any[] = []): T | null {
  const rows = getDb().query(sql).all(...params) as T[];
  return rows.length > 0 ? rows[0] : null;
}

export function run(sql: string, params: any[] = []): { changes: number; lastInsertRowid: number } {
  const result = getDb().run(sql, params);
  return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
}

export function insert(sql: string, params: any[] = []): number {
  return run(sql, params).lastInsertRowid;
}

export function transaction<T>(fn: () => T): T {
  return getDb().transaction(fn)();
}

export function closeDb(): void {
  if (db) {
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch { /* ignore */ }
    db.close();
    db = null;
  }
}

/** Simple persisted counters/configuration in the settings table. */
export function getSetting(key: string, fallback: string | null = null): string | null {
  const row = queryOne<{ value: string }>("SELECT value FROM settings WHERE key = ?", [key]);
  return row ? row.value : fallback;
}

export function setSetting(key: string, value: string, secret = false): void {
  run(
    `INSERT INTO settings (key, value, secret, updated_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, secret = excluded.secret,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    [key, value, secret ? 1 : 0],
  );
}

export function backupDatabase(destination: string): void {
  const connection = getDb();
  connection.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`);
}

export function pruneOldMetrics(olderThanMs: number): void {
  const cutoff = Date.now() - olderThanMs;
  run("DELETE FROM server_metrics WHERE ts < ?", [cutoff]);
}

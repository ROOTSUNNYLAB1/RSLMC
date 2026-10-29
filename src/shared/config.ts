import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { migrateLegacyData, resolveDataLocation, type DataLocation } from "./data-location";

export type PanelMode = "development" | "production";

const ROOT = resolve(dirname(import.meta.dir), "..");

function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const fileEnv = readEnvFile(join(ROOT, ".env"));
const env = (key: string, fallback = ""): string => process.env[key] ?? fileEnv[key] ?? fallback;

/**
 * Panel version — Calendar Versioning (`YYYY.MM.DD`, optional same-day revision). The single source
 * of truth is package.json, so `bun pm version` and the update checker can never disagree.
 */
function readAppVersion(): string {
  try {
    const raw = readFileSync(join(ROOT, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    const version = (parsed.version ?? "").trim();
    // Guard against a fork that still carries a semver string: the About page and the updater both
    // expect CalVer, and a silent fallback is better than a 500 in the middle of an update.
    return /^v?\d{4}\.\d{1,2}\.\d{1,2}/.test(version) ? version.replace(/^v/, "") : "2026.10.29";
  } catch {
    return "2026.10.29";
  }
}

export const APP_VERSION = readAppVersion();
export const ROOT_DIR = ROOT;
export const MODE: PanelMode = (env("RSLMC_MODE", "development") === "production" ? "production" : "development");
export const PORT = Number(env("RSLMC_PORT", "3000"));
export const HOST = env("RSLMC_HOST", "0.0.0.0");
export const TRUST_PROXY = env("RSLMC_TRUST_PROXY", "false") === "true";
/*
 * One folder holds the whole installation. Linux → /opt/rslmc, Windows → %ProgramData%\RSLMC (or
 * %LOCALAPPDATA%\RSLMC without admin rights), macOS → ~/Library/Application Support/RSLMC.
 * RSLMC_DATA_DIR overrides it; see src/shared/data-location.ts.
 */
export const DATA_LOCATION = resolveDataLocation({
  rootDir: ROOT,
  env: {
    RSLMC_DATA_DIR: env("RSLMC_DATA_DIR", "") || undefined,
    RSLMC_DATA_ROOT: env("RSLMC_DATA_ROOT", "") || undefined,
    ProgramData: process.env.ProgramData,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    APPDATA: process.env.APPDATA,
  },
  legacyDir: join(ROOT, "runtime"),
  // Upgrading the code must never relocate a live installation; the move is opt-in.
  adoptLegacy: env("RSLMC_ADOPT_LEGACY", "false") === "true",
});
export const DATA_DIR = DATA_LOCATION.dir;
export const PUBLIC_DIR = join(ROOT, "public");
export const FRONTEND_DIR = join(ROOT, "frontend");

export const PATHS = {
  data: DATA_DIR,
  database: join(DATA_DIR, "database"),
  dbFile: join(DATA_DIR, "database", "rslmc.db"),
  java: join(DATA_DIR, "java"),
  servers: join(DATA_DIR, "servers"),
  backups: join(DATA_DIR, "backups"),
  downloads: join(DATA_DIR, "downloads"),
  cache: join(DATA_DIR, "cache"),
  logs: join(DATA_DIR, "logs"),
  temporary: join(DATA_DIR, "temporary"),
  nodes: join(DATA_DIR, "nodes"),
  secrets: join(DATA_DIR, "secrets"),
  installers: join(DATA_DIR, "cache", "installers"),
  avatars: join(DATA_DIR, "avatars"),
};

const REQUIRED_DIRS = [
  PATHS.database, PATHS.java, PATHS.servers, PATHS.backups,
  PATHS.downloads, PATHS.cache, PATHS.logs, PATHS.temporary, PATHS.nodes, PATHS.secrets, PATHS.installers,
  PATHS.avatars,
];

/**
 * Adopts an older `<app>/runtime` install into the new platform location. Call this once at boot,
 * before ensureDirectories()/getDb(), so a panel upgraded from "data next to the code" keeps its
 * database, servers and secrets without any manual copying.
 */
export function adoptLegacyDataDir(): { migrated: boolean; note: string | null } {
  // Only an explicit opt-in (RSLMC_ADOPT_LEGACY=true) moves data into the platform folder.
  if (DATA_LOCATION.source !== "platform-default") return { migrated: false, note: null };
  const legacy = join(ROOT, "runtime");
  const result = migrateLegacyData(DATA_DIR, legacy);
  return { migrated: result.migrated, note: result.note };
}

export function ensureDirectories(): void {
  for (const dir of REQUIRED_DIRS) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o750 });
  }
}

/**
 * The application secret protects signed cookies and is generated once on first run.
 * A production deployment may supply RSLMC_SECRET explicitly; we never log it.
 */
export function loadAppSecret(): string {
  const fromEnv = env("RSLMC_SECRET", "");
  if (fromEnv.length >= 32) return fromEnv;
  if (MODE === "production" && fromEnv.length > 0) {
    throw new Error("RSLMC_SECRET must be at least 32 characters in production mode.");
  }
  ensureDirectories();
  const secretFile = join(PATHS.secrets, "panel.key");
  if (existsSync(secretFile)) return readFileSync(secretFile, "utf8").trim();
  const secret = randomBytes(32).toString("hex");
  writeFileSync(secretFile, secret, { mode: 0o600 });
  try { chmodSync(secretFile, 0o600); } catch { /* best effort on Windows */ }
  return secret;
}

export function serverDir(serverUuid: string): string {
  return join(PATHS.servers, serverUuid);
}

export function serverBackupDir(serverUuid: string): string {
  return join(PATHS.backups, serverUuid);
}

/** Host facts that never require root to read. */
export function hostPlatform(): { os: "windows" | "linux" | "darwin"; arch: "x64" | "arm64"; label: string } {
  const platform = process.platform;
  const os = platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return { os, arch, label: `${os}-${arch}` };
}

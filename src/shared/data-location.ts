import { accessSync, cpSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync, unlinkSync, readdirSync, constants } from "node:fs";
import { join, resolve } from "node:path";
import { posix, win32 } from "node:path";
import { homedir } from "node:os";

/**
 * Where RSLMC keeps *everything* — database, servers, Java runtimes, downloads, backups, logs.
 *
 * The whole installation lives in one directory so it can be deleted, zipped or copied as a single
 * unit without touching the application code:
 *
 * | Platform | Default location                     | Why |
 * | -------- | ------------------------------------ | --- |
 * | Linux    | `/opt/rslmc`                         | one predictable path, easy to wipe/back up |
 * | Windows  | `%ProgramData%\\RSLMC`                | machine-wide, survives per-user profiles |
 * | Windows (no admin rights) | `%LOCALAPPDATA%\\RSLMC` | always writable for the current user |
 * | macOS    | `~/Library/Application Support/RSLMC` | platform convention |
 *
 * `RSLMC_DATA_DIR` overrides everything (relative paths resolve against the application folder).
 * If the platform default cannot be created (e.g. `/opt` is not writable and the panel was not
 * started as root), RSLMC falls back to `<app>/runtime` and says so loudly instead of failing.
 */

export type DataLocationSource = "env" | "platform-default" | "existing-install" | "local-fallback";

export interface DataLocation {
  dir: string;
  source: DataLocationSource;
  /** Human readable explanation when the result is not what the platform would normally use. */
  note: string | null;
  /** The candidates that were tried, in order (useful for the startup banner / System page). */
  considered: string[];
}

export interface LocationEnv {
  RSLMC_DATA_DIR?: string;
  RSLMC_DATA_ROOT?: string;
  ProgramData?: string;
  LOCALAPPDATA?: string;
  APPDATA?: string;
}

/** Ordered list of platform default data directories (first writable one wins). */
export function platformDataCandidates(platform: NodeJS.Platform, env: LocationEnv, home = homedir()): string[] {
  // Path separators must match the *target* platform, not the host running the tests.
  const path = platform === "win32" ? win32 : posix;
  // RSLMC_DATA_ROOT only changes *where* the platform default lives (used by tests and by
  // installations that want /opt everywhere but on a different volume).
  const root = env.RSLMC_DATA_ROOT?.trim();
  if (platform === "win32") {
    const candidates: string[] = [];
    // ProgramData is machine-wide (needs admin to create); LOCALAPPDATA always works for the
    // current user. Roaming is deliberately not used — server jars and worlds must not roam.
    const programData = env.ProgramData?.trim() ?? "";
    const localAppData = env.LOCALAPPDATA?.trim() ?? env.APPDATA?.trim()
      ?? (home ? path.join(home, "AppData", "Local") : "");
    if (root) candidates.push(path.join(root, "RSLMC"));
    if (programData) candidates.push(path.join(programData, "RSLMC"));
    if (localAppData) candidates.push(path.join(localAppData, "RSLMC"));
    return candidates;
  }
  if (platform === "darwin") {
    return [root ? path.join(root, "rslmc") : path.join(home, "Library", "Application Support", "RSLMC")];
  }
  // Linux (and anything else unix-like): a single, obvious directory.
  return [root ? path.join(root, "rslmc") : "/opt/rslmc"];
}

/**
 * Returns null when `dir` can be used, otherwise an error message.
 * Creation is attempted so a first run on a fresh machine "just works".
 */
export function probeWritable(dir: string): string | null {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o750 });
    const stats = statSync(dir);
    if (!stats.isDirectory()) return `${dir} exists but is not a directory`;
    accessSync(dir, constants.W_OK);
    const probe = join(dir, ".rslmc-write-probe");
    writeFileSync(probe, "ok");
    unlinkSync(probe);
    return null;
  } catch (err: any) {
    return err?.code === "EACCES" || err?.code === "EPERM"
      ? `permission denied for ${dir}`
      : `${err?.message ?? String(err)}`;
  }
}

export interface ResolveOptions {
  rootDir: string;
  platform?: NodeJS.Platform;
  env?: LocationEnv;
  home?: string;
  probe?: (dir: string) => string | null;
  /**
   * An older install that keeps its data next to the code (`<app>/runtime`). It is used in place by
   * default: an upgrade must never move a live database behind the operator's back.
   */
  legacyDir?: string;
  /** Opt in to moving `<app>/runtime` into the platform folder (RSLMC_ADOPT_LEGACY=true). */
  adoptLegacy?: boolean;
}

/** True when the folder holds an RSLMC database (i.e. it is a real installation, not an empty dir). */
export function hasDatabase(dir: string): boolean {
  return existsSync(join(dir, "database", "rslmc.db"));
}

export function resolveDataLocation(options: ResolveOptions): DataLocation {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? (process.env as LocationEnv);
  const probe = options.probe ?? probeWritable;
  const considered: string[] = [];
  /*
   * Path arithmetic follows the *target* platform, not the host running the code: the same function
   * resolves a Windows layout when asked about win32 and a POSIX layout when asked about linux (the
   * test suite relies on this, and so does a panel started with a mocked platform). For a real run
   * `platform` is process.platform, so this is simply the normal behaviour.
   */
  const path = platform === "win32" ? win32 : posix;

  const explicit = env.RSLMC_DATA_DIR?.trim();
  if (explicit) {
    const dir = path.isAbsolute(explicit) ? path.normalize(explicit) : path.resolve(options.rootDir, explicit);
    considered.push(dir);
    // An explicit choice is honoured even if it looks unwritable: the operator asked for it, and
    // ensureDirectories()/Bun will surface the real error instead of silently moving their data.
    return { dir, source: "env", note: null, considered };
  }

  /*
   * A panel that is already running from `<app>/runtime` keeps working exactly as before. Moving the
   * data is a one-time, deliberate action (`bun scripts/move-data.ts` or RSLMC_ADOPT_LEGACY=true),
   * never a side effect of updating the code.
   */
  const legacyDir = options.legacyDir;
  if (legacyDir && hasDatabase(legacyDir) && !options.adoptLegacy) {
    considered.push(legacyDir);
    return {
      dir: legacyDir,
      source: "existing-install",
      note: `Using the existing data folder ${legacyDir} (kept in place — nothing was moved). `
        + "To consolidate everything in the platform folder later, run `bun scripts/move-data.ts`"
        + `${platform === "win32" ? " or set RSLMC_DATA_DIR" : " (target: /opt/rslmc)"}.`,
      considered,
    };
  }

  const candidates = platformDataCandidates(platform, env, options.home);
  const failures: string[] = [];
  for (const candidate of candidates) {
    considered.push(candidate);
    const failure = probe(candidate);
    if (!failure) {
      return { dir: candidate, source: "platform-default", note: null, considered };
    }
    failures.push(failure);
  }

  const fallback = path.resolve(options.rootDir, "runtime");
  considered.push(fallback);
  const fallbackFailure = probe(fallback);
  const reason = failures.join("; ") || "no platform folder available";
  return {
    dir: fallback,
    source: "local-fallback",
    note: fallbackFailure
      ? `Could not use the platform data folder (${reason}) and the local fallback failed too (${fallbackFailure}). Set RSLMC_DATA_DIR to a writable folder.`
      : `Could not use the platform data folder (${reason}) — keeping everything in ${fallback}. Start the panel with the rights to create that folder, or set RSLMC_DATA_DIR.`,
    considered,
  };
}

export interface MigrationResult {
  migrated: boolean;
  /** Directories that were moved into the new location. */
  moved: string[];
  note: string | null;
}

/**
 * Moves an older `<app>/runtime` installation into the platform data directory, so upgrading does
 * not require the operator to copy the database by hand. Only runs when the target has no database
 * yet; the move is a rename where possible and a recursive copy + delete across filesystems.
 */
export function migrateLegacyData(targetDir: string, legacyDir: string): MigrationResult {
  const legacyDb = join(legacyDir, "database", "rslmc.db");
  const targetDb = join(targetDir, "database", "rslmc.db");
  if (resolve(targetDir) === resolve(legacyDir)) return { migrated: false, moved: [], note: null };
  if (!existsSync(legacyDb)) return { migrated: false, moved: [], note: null };
  if (existsSync(targetDb)) return { migrated: false, moved: [], note: null };

  const moved: string[] = [];
  let note: string | null = null;
  try {
    mkdirSync(targetDir, { recursive: true, mode: 0o750 });
    for (const entry of readdirSync(legacyDir)) {
      const from = join(legacyDir, entry);
      const to = join(targetDir, entry);
      if (existsSync(to)) {
        // Never overwrite the new location; the legacy copy is left in place.
        note = `Left ${to} untouched (already exists) while migrating ${legacyDir}.`;
        continue;
      }
      try {
        renameSync(from, to);
      } catch {
        cpSync(from, to, { recursive: true });
        rmSync(from, { recursive: true, force: true });
      }
      moved.push(entry);
    }
    if (moved.length > 0) {
      try { rmSync(legacyDir, { recursive: true, force: true }); } catch { /* leftovers are harmless */ }
      note = `Moved existing data from ${legacyDir} to ${targetDir}: ${moved.join(", ")}.`;
    }
  } catch (err: any) {
    return {
      migrated: false,
      moved,
      note: `Could not migrate ${legacyDir} to ${targetDir}: ${err?.message ?? String(err)}. `
        + "The panel will start with the new (empty) location; copy the folder manually if you need the old data.",
    };
  }
  return { migrated: moved.length > 0, moved, note };
}

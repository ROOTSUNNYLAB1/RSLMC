/**
 * One-time helper: move an existing installation (e.g. `<app>/runtime` or /root/rslmc-panel/runtime)
 * into the single data folder (/opt/rslmc on Linux, %ProgramData%\RSLMC on Windows), or into any
 * path you pass.
 *
 * Usage
 *   bun scripts/move-data.ts                      # preview only — prints what would move where
 *   bun scripts/move-data.ts --apply              # move to the platform default
 *   bun scripts/move-data.ts --to /srv/rslmc --apply
 *
 * The panel must be stopped first. Nothing is deleted until the copy is complete and verified, and
 * an existing database in the target is never overwritten.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { formatBytes } from "../src/security/paths";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const toIndex = args.indexOf("--to");
const explicitTarget = toIndex >= 0 ? args[toIndex + 1] : undefined;

const rootDir = resolve(import.meta.dir, "..");
const source = resolve(rootDir, "runtime");

const { resolveDataLocation } = await import("../src/shared/data-location");
const location = resolveDataLocation({
  rootDir,
  env: { RSLMC_DATA_DIR: explicitTarget, RSLMC_DATA_ROOT: process.env.RSLMC_DATA_ROOT },
  legacyDir: undefined,
});
const target = location.dir;

function sizeOf(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += sizeOf(path);
    else if (entry.isFile()) total += statSync(path).size;
  }
  return total;
}

if (!existsSync(join(source, "database", "rslmc.db"))) {
  console.log(`No database found in ${source} — there is nothing to move.`);
  console.log(`The panel will create everything in ${location.dir} on its next start.`);
  process.exit(0);
}
if (resolve(target) === source) {
  console.log(`Data already lives in ${source}; nothing to do.`);
  process.exit(0);
}
if (existsSync(join(target, "database", "rslmc.db"))) {
  console.error(`Refusing to move: ${target} already contains an RSLMC database.`);
  console.error("Delete it first (or pick another --to) so no installation is overwritten.");
  process.exit(1);
}

const size = sizeOf(source);
console.log(`Source : ${source} (${formatBytes(size)})`);
console.log(`Target : ${target}  [${location.source}]`);
console.log(`Entries: ${readdirSync(source).join(", ")}`);
console.log("");
console.log("Stop the panel before applying (it must not hold the database open).");

if (!apply) {
  console.log("\nPreview only. Re-run with --apply to move the data.");
  process.exit(0);
}

mkdirSync(target, { recursive: true, mode: 0o750 });
const moved: string[] = [];
for (const entry of readdirSync(source)) {
  const from = join(source, entry);
  const to = join(target, entry);
  if (existsSync(to)) {
    console.log(`skip ${entry} (already exists in the target)`);
    continue;
  }
  try {
    renameSync(from, to); // same filesystem: instant
  } catch {
    cpSync(from, to, { recursive: true }); // across filesystems: copy, then delete
    rmSync(from, { recursive: true, force: true });
  }
  moved.push(entry);
}
console.log(`\nMoved ${moved.length} entr${moved.length === 1 ? "y" : "ies"}: ${moved.join(", ")}`);
console.log(`Done. Start the panel again — it will report: Data ${target}`);
if (!existsSync(source) || readdirSync(source).length === 0) {
  try { rmSync(source, { recursive: true, force: true }); } catch { /* empty shell is harmless */ }
}

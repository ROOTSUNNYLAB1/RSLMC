/**
 * Cuts a new panel version using CalVer (`YYYY.MM.DD`, plus `.N` for a second release the same day).
 *
 *   bun run release            # bump package.json to today's version and print the next steps
 *   bun run release --dry-run  # show what would be written
 *
 * The version in package.json is the only source of truth: the startup banner, the About page, the
 * `x-rslmc-version` response header and the update checker all read it. A git tag `v<version>` plus a
 * GitHub release (see `.github/workflows/release.yml`, which builds the archive and its SHA256SUMS)
 * is what the update checker sees as an available update.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { compareCalVer, parseCalVer, todayCalVer } from "../src/shared/calver";

const ROOT = resolve(dirname(import.meta.dir), "..");
const PKG = join(ROOT, "package.json");
const dryRun = process.argv.includes("--dry-run");

function readVersion(): string {
  const pkg = JSON.parse(readFileSync(PKG, "utf8")) as { version?: string };
  return (pkg.version ?? "").trim();
}

function writeVersion(version: string): void {
  const text = readFileSync(PKG, "utf8");
  // Replace only the top-level version field, keeping the file's existing formatting.
  const updated = text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
  if (updated === text) throw new Error(`could not find the version field in ${PKG}`);
  writeFileSync(PKG, updated);
}

const current = readVersion();
const parsedCurrent = parseCalVer(current);
const today = todayCalVer(new Date());
const sameDay = parsedCurrent?.raw.startsWith(today) ?? false;
const next = sameDay ? todayCalVer(new Date(), (parsedCurrent?.revision ?? 0) + 1) : today;

if (compareCalVer(next, current) <= 0) {
  console.error(`Refusing to go backwards: ${current} → ${next}`);
  process.exit(1);
}

console.log(`current  ${current}`);
console.log(`next     ${next}${dryRun ? "  (dry run — nothing written)" : ""}`);

if (!dryRun) {
  writeVersion(next);
  console.log(`\npackage.json updated. To publish this release:\n`);
  console.log(`  git add package.json && git commit -m "release: ${next}"`);
  console.log(`  git tag v${next}`);
  console.log(`  git push origin main --tags\n`);
  console.log(`The tag workflow builds rslmc-${next}.tar.gz + SHA256SUMS and creates the GitHub release.`);
  console.log(`Running panels see it on their next check (Administration → About → Check for updates).`);
} else {
  console.log("\nAhoy — dry run only.");
}

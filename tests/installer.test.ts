import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/*
 * R1 — the installer has to survive being *run*.
 *
 * v2026.11.02.1 called `canonical_path` 200 lines before it was defined. `bash -n` and shellcheck both
 * pass on that; every install and every documented upgrade died at step [2/14]. This suite executes
 * the real script in `--dry-run --unattended` mode, so the class of bug cannot come back unnoticed.
 *
 * The heavy lifting lives in `scripts/installer-smoke.sh` (also a CI step) — this file makes it part
 * of `bun run test`, where it is hardest to miss.
 */
const ROOT = join(import.meta.dir, "..");

describe("install.sh", () => {
  test("runs, plans and exits cleanly (dry run, nothing touched)", () => {
    const result = Bun.spawnSync(["bash", join(ROOT, "scripts", "installer-smoke.sh")], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    expect(output).toContain("all installer checks passed");
    expect(result.exitCode).toBe(0);
  }, 120_000);

  test("every helper is defined before its first call", () => {
    // The check itself lives in the smoke script; this asserts it actually covers the culprit.
    const result = Bun.spawnSync(["bash", join(ROOT, "scripts", "installer-smoke.sh")], {
      cwd: ROOT, stdout: "pipe", stderr: "pipe",
    });
    const output = result.stdout.toString();
    expect(output).toContain("canonical_path defined");
    expect(output).not.toContain("is called on line");
  }, 120_000);
});

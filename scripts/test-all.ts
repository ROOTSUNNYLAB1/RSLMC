/**
 * Runs every test file in its own process.
 *
 *   bun run test          # all files
 *   bun run test tests/update.test.ts
 *
 * Why not plain `bun test`? Several suites boot a real panel against a real SQLite file, and the data
 * root is resolved once per process (`src/shared/config.ts`). When a dozen such files share one
 * process, whichever file imports the config first pins the data folder for everyone — so a passing
 * file could fail purely because another file ran before it, and a temp database deleted by one file
 * broke the next. That is a flake, not a finding. One process per file gives every suite the data
 * folder it asked for, and the wall-clock cost is a couple of seconds.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const files = requested.length > 0
  ? requested
  : readdirSync(join(ROOT, "tests"))
      .filter((name) => name.endsWith(".test.ts"))
      .sort()
      .map((name) => join("tests", name));

const timeout = process.env.RSLMC_TEST_TIMEOUT ?? "120000";
let passed = 0;
let failed = 0;
const failures: string[] = [];

for (const file of files) {
  const started = Date.now();
  const result = Bun.spawnSync([process.execPath, "test", "--timeout", timeout, file], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  const ok = result.exitCode === 0;
  const summary = /(\d+)\s+pass[\s\S]*?(\d+)\s+fail/.exec(output);
  const counts = summary ? `${summary[1]} pass, ${summary[2]} fail` : ok ? "ok" : "failed";
  console.log(`${ok ? "✓" : "✗"} ${file} — ${counts} (${((Date.now() - started) / 1000).toFixed(1)} s)`);

  if (ok) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(file);
    // Show what broke, without drowning the summary: the failing lines and the error text.
    const lines = output.split("\n").filter((line) => /^\(fail\)|error:|Expected|Received|^tests?\//.test(line.trim()));
    console.log(lines.slice(0, 25).map((line) => `    ${line}`).join("\n"));
  }
}

console.log(`\n${passed} file(s) passed, ${failed} failed — ${files.length} total`);
if (failed > 0) {
  console.log(`Failing: ${failures.join(", ")}`);
  process.exit(1);
}

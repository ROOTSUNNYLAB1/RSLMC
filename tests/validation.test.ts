import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { validate, v } from "../src/shared/http";

/*
 * `validate(schema, body)` — and the release that got it backwards.
 *
 * `/api/panel/update/settings` shipped as `validate(await ctx.body(), updateSettingsSchema)`. Nothing
 * complained: `ctx.body()` is typed `any`, so TypeScript saw no problem, the build stayed green, and
 * the only symptom was a 500 reading
 *
 *   TypeError: validator is not a function. (In 'validator(input?.[key])', 'validator' is 30)
 *
 * — the `30` being a request value from the body, not anything to do with the bug. These tests pin
 * both halves of the fix: the call sites, and the guard that now names the mistake out loud.
 */

const ROOT = join(import.meta.dir, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("validate()", () => {
  test("accepts a valid body and returns the coerced values", () => {
    const input = validate(
      { autoCheck: v.boolean({ optional: true }), intervalMinutes: v.number({ min: 30, max: 1440, optional: true }) },
      { autoCheck: true, intervalMinutes: "60" },
    );
    expect(input.autoCheck).toBe(true);
    expect(input.intervalMinutes).toBe(60);
  });

  test("rejects a bad body with a per-field message", () => {
    let thrown: any = null;
    try {
      validate({ intervalMinutes: v.number({ min: 30 }) }, { intervalMinutes: 5 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeTruthy();
    expect(thrown.code).toBe("bad_request");
    expect(JSON.stringify(thrown.details)).toContain("at least 30");
  });

  test("swapped arguments fail with an explanation, not 'validator is not a function'", () => {
    let thrown: any = null;
    try {
      // The exact shape of the shipped bug: body first, schema second.
      validate({ intervalMinutes: 30 } as any, { intervalMinutes: 30 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeTruthy();
    expect(String(thrown.message)).toContain("arguments look swapped");
    expect(String(thrown.message)).toContain("intervalMinutes");
    expect(String(thrown.message)).not.toContain("is not a function");
  });

  test("an empty or missing body does not crash the loop", () => {
    let thrown: any = null;
    try {
      validate({ intervalMinutes: v.number({ min: 30 }) } as any, undefined as any);
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).toBe("bad_request");
  });

  test("no source file passes the body in the schema slot", () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, "src"))) {
      if (file.endsWith(join("shared", "http.ts"))) continue; // the helper's own documentation
      const text = readFileSync(file, "utf8");
      // validate(await ctx.body(), …) / validate(body, …) — the first argument must be a schema.
      for (const match of text.matchAll(/validate\(\s*([^,\n]+)\s*,/g)) {
        const first = match[1]!.trim();
        const looksLikeBody = /body\(|^body$|^await ctx\.body/.test(first);
        if (looksLikeBody) offenders.push(`${file}: validate(${first}, …)`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

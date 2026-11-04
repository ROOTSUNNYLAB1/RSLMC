import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { daysAheadOfToday, daysBetween, parseCalVerParts } from "../src/shared/calver-guard";
import { APP_VERSION } from "../src/shared/config";

/*
 * The version in package.json is a date, and this suite is what stops it from being a wrong one.
 *
 * It exists because of a real mistake: v2026.11.05.1 was released on 4 November 2026. Every other test
 * was happy — the string parses as CalVer, it sorts above the previous release, the update checker
 * compares it fine — and the panel advertised a build from the next day.
 */

const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string };

describe("the shipped version is a real date", () => {
  test("package.json and the panel's own APP_VERSION are the same string", () => {
    // Two sources of truth is how the dashboard once showed a placeholder build number.
    expect(APP_VERSION).toBe(pkg.version);
  });

  test("it parses as CalVer with a real calendar date", () => {
    const parts = parseCalVerParts(pkg.version);
    expect(parts).not.toBeNull();
    expect(parts!.year).toBeGreaterThanOrEqual(2026);
  });

  test("it is not dated in the future", () => {
    // One day of slack for timezones (a release cut at 02:00 IST is still the previous day in UTC).
    const ahead = daysAheadOfToday(pkg.version);
    expect(ahead).not.toBeNull();
    expect(ahead!).toBeLessThanOrEqual(1);
  });

  test("it is not years in the past either — that would mean the file was never bumped", () => {
    const parts = parseCalVerParts(pkg.version)!;
    const age = daysBetween(parts, { year: 2026, month: 11, day: 4, build: 1 });
    expect(age).toBeLessThan(400);
  });
});

describe("the guard's own arithmetic", () => {
  test("impossible dates are rejected", () => {
    expect(parseCalVerParts("2026.02.31")).toBeNull();
    expect(parseCalVerParts("2026.13.01")).toBeNull();
    // The panel ships year.month.day only; a two-part string is not a release version.
    expect(parseCalVerParts("2026.11")).toBeNull();
    expect(parseCalVerParts("not-a-version")).toBeNull();
  });

  test("days ahead, forward and back", () => {
    const today = new Date("2026-11-04T12:00:00Z");
    expect(daysAheadOfToday("2026.11.04.3", today)).toBe(0);
    expect(daysAheadOfToday("2026.11.05.1", today)).toBe(1);
    expect(daysAheadOfToday("2026.11.06.1", today)).toBe(2);
    expect(daysAheadOfToday("2026.11.02.1", today)).toBe(-2);
  });
});

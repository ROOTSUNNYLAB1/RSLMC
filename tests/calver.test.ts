import { describe, expect, test } from "bun:test";
import {
  compareCalVer, describeReleaseAge, isCalVer, isNewerCalVer, parseCalVer, todayCalVer,
} from "../src/shared/calver";

/*
 * CalVer is the whole basis of "is this newer?" — if a comparison is wrong the panel either nags
 * about an update that is already installed or, worse, silently ignores a real one.
 */
describe("parsing", () => {
  test("accepts the canonical form", () => {
    const version = parseCalVer("2026.10.29");
    expect(version).not.toBeNull();
    expect(version!.year).toBe(2026);
    expect(version!.month).toBe(10);
    expect(version!.day).toBe(29);
    expect(version!.revision).toBe(0);
    expect(version!.prerelease).toBe("");
  });

  test("tolerates a leading v and same-day revisions", () => {
    expect(parseCalVer("v2026.10.29")!.raw).toBe("2026.10.29");
    expect(parseCalVer("2026.10.29.3")!.revision).toBe(3);
    expect(parseCalVer("2026.1.5")!.month).toBe(1);
  });

  test("reads prereleases", () => {
    const beta = parseCalVer("2026.10.29-beta.2");
    expect(beta!.prerelease).toBe("beta.2");
    expect(beta!.revision).toBe(0);
  });

  test("rejects nonsense instead of guessing", () => {
    for (const value of ["", "1.0.0", "2026", "2026.13.01", "2026.10.32", "latest", null, undefined, "v2026.aa.01"]) {
      expect(parseCalVer(value as any)).toBeNull();
      expect(isCalVer(value as any)).toBe(false);
    }
  });

  test("today's suggestion is a valid CalVer", () => {
    const today = todayCalVer(new Date("2026-10-29T12:00:00Z"));
    expect(today).toBe("2026.10.29");
    expect(isCalVer(today)).toBe(true);
    expect(todayCalVer(new Date("2026-10-29T12:00:00Z"), 2)).toBe("2026.10.29.2");
  });
});

describe("comparison", () => {
  test("orders by date", () => {
    expect(compareCalVer("2026.10.29", "2026.11.02")).toBeLessThan(0);
    expect(compareCalVer("2026.11.02", "2026.10.29")).toBeGreaterThan(0);
    expect(compareCalVer("2025.12.31", "2026.01.01")).toBeLessThan(0);
    expect(isNewerCalVer("2026.10.29", "2026.10.29")).toBe(false);
  });

  test("a same-day revision is newer than the plain date", () => {
    expect(isNewerCalVer("2026.10.29.1", "2026.10.29")).toBe(true);
    expect(isNewerCalVer("2026.10.29", "2026.10.29.1")).toBe(false);
    expect(isNewerCalVer("2026.10.29.2", "2026.10.29.1")).toBe(true);
  });

  test("nullable strings never look like an upgrade", () => {
    expect(compareCalVer(null, "2026.10.29")).toBeLessThan(0);
    expect(compareCalVer("2026.10.29", null)).toBeGreaterThan(0);
    expect(compareCalVer(null, null)).toBe(0);
    expect(isNewerCalVer("garbage", "2026.10.29")).toBe(false);
    expect(isNewerCalVer("2026.10.29", "garbage")).toBe(true);
  });

  test("stable beats the prerelease of the same date", () => {
    expect(isNewerCalVer("2026.10.29", "2026.10.29-beta.1")).toBe(true);
    expect(isNewerCalVer("2026.10.29-beta.1", "2026.10.29")).toBe(false);
    expect(isNewerCalVer("2026.10.29-beta.2", "2026.10.29-beta.1")).toBe(true);
  });

  test("is transitive across a shuffled list", () => {
    const sorted = ["2026.01.04", "2026.10.29", "2026.02.11", "2025.12.30"]
      .sort(compareCalVer);
    expect(sorted).toEqual(["2025.12.30", "2026.01.04", "2026.02.11", "2026.10.29"]);
  });
});

describe("release age", () => {
  test("reads like a sentence", () => {
    const now = Date.UTC(2026, 9, 29, 12);
    expect(describeReleaseAge("2026.10.29", now)).toBe("today");
    expect(describeReleaseAge("2026.10.28", now)).toBe("yesterday");
    expect(describeReleaseAge("2026.10.19", now)).toBe("10 days ago");
    expect(describeReleaseAge("2026.08.29", now)).toBe("2 months ago");
    expect(describeReleaseAge("2024.10.29", now)).toBe("2 years ago");
  });

  test("returns null when the version is not CalVer", () => {
    expect(describeReleaseAge("1.2.3")).toBeNull();
  });
});

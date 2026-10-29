import { describe, expect, test } from "bun:test";
import { resolveMemoryUsage } from "../src/resources/cgroups";

/*
 * A partially delegated cgroup reports a plausible-looking but absurd number: this sandbox handed
 * out a limit of 1536 MB while `memory.current` read 184 KB for a JVM holding 344 MB. Believing the
 * cgroup there is a fake metric — the panel must fall back to the process RSS and say so.
 */
describe("memory usage source", () => {
  test("a cgroup that accounts for the process wins", () => {
    const picked = resolveMemoryUsage(700 * 1024 ** 2, 760 * 1024 ** 2);
    expect(picked.source).toBe("cgroup");
    expect(picked.cgroupTrusted).toBe(true);
    expect(picked.bytes).toBe(700 * 1024 ** 2);
  });

  test("a cgroup that clearly is not charging the process is ignored", () => {
    const picked = resolveMemoryUsage(188_416, 361_222_144);
    expect(picked.source).toBe("/proc");
    expect(picked.cgroupTrusted).toBe(false);
    expect(picked.bytes).toBe(361_222_144);
  });

  test("no cgroup at all falls back to the process", () => {
    expect(resolveMemoryUsage(null, 512 * 1024 ** 2)).toEqual({
      bytes: 512 * 1024 ** 2, source: "/proc", cgroupTrusted: false,
    });
  });

  test("no process sample falls back to the cgroup", () => {
    expect(resolveMemoryUsage(300 * 1024 ** 2, null)).toEqual({
      bytes: 300 * 1024 ** 2, source: "cgroup", cgroupTrusted: true,
    });
  });

  test("a stopped server reports zero, never a stale number", () => {
    expect(resolveMemoryUsage(null, null)).toEqual({ bytes: 0, source: "none", cgroupTrusted: false });
  });

  test("nonsense values are treated as missing", () => {
    expect(resolveMemoryUsage(Number.NaN, 100 * 1024 ** 2).source).toBe("/proc");
    expect(resolveMemoryUsage(-5, 100 * 1024 ** 2).source).toBe("/proc");
    expect(resolveMemoryUsage(0, 0)).toEqual({ bytes: 0, source: "none", cgroupTrusted: false });
  });
});

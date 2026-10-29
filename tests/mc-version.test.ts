import { describe, expect, test } from "bun:test";
import { compareMcVersions, summariseGameVersions, summariseLoaders } from "../frontend/lib/mc-version";

describe("marketplace version display", () => {
  // SkinRestorer reports this exact list (oldest first) — the old code showed the first four entries,
  // i.e. "1.8, 1.8.1, 1.8.2, 1.8.3", on every row of every project.
  const skinRestorer = ["1.8", "1.8.1", "1.8.2", "1.8.3", "1.19", "1.20", "1.20.1", "1.21", "1.21.4"];

  test("versions are ordered numerically, not by Modrinth's raw order", () => {
    expect([...skinRestorer].sort(compareMcVersions)).toEqual(skinRestorer as any);
    expect(compareMcVersions("1.9", "1.10")).toBeLessThan(0);
    expect(compareMcVersions("1.21.4", "1.21")).toBeGreaterThan(0);
    expect(compareMcVersions("1.8", "1.8.1")).toBeLessThan(0);
  });

  test("the preview shows the newest versions instead of the oldest four", () => {
    const summary = summariseGameVersions(skinRestorer, "1.21.4");
    expect(summary.recent).toEqual(["1.21.4", "1.21", "1.20.1"]);
    expect(summary.newest).toBe("1.21.4");
    expect(summary.oldest).toBe("1.8");
    expect(summary.range).toBe("1.8 – 1.21.4");
    expect(summary.total).toBe(9);
    expect(summary.supportsCurrent).toBe(true);
  });

  test("a build that misses the server version is reported honestly", () => {
    const summary = summariseGameVersions(["1.20", "1.20.1"], "1.21.4");
    expect(summary.supportsCurrent).toBe(false);
    expect(summary.recent).toEqual(["1.20.1", "1.20"]);
    expect(summary.range).toBe("1.20 – 1.20.1");
  });

  test("duplicates, empty and missing lists never break the cell", () => {
    expect(summariseGameVersions(["1.20", "1.20"], null).total).toBe(1);
    expect(summariseGameVersions([], "1.21.4").range).toBe("—");
    expect(summariseGameVersions(undefined, "1.21.4").total).toBe(0);
    expect(summariseGameVersions(["1.21.4"], "1.21.4").range).toBe("1.21.4");
  });

  test("loader lists are compacted with a hidden-count", () => {
    const loaders = ["bukkit", "bungeecord", "folia", "paper", "purpur", "spigot", "velocity", "waterfall"];
    const summary = summariseLoaders(loaders);
    expect(summary.shown).toBe("bukkit, bungeecord, folia");
    expect(summary.hidden).toHaveLength(5);
    expect(summariseLoaders(["paper"]).hidden).toHaveLength(0);
    expect(summariseLoaders([]).shown).toBe("—");
  });
});

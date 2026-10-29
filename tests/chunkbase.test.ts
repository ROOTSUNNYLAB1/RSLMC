import { describe, expect, test } from "bun:test";
import {
  CHUNKBASE_PLATFORMS,
  chunkbasePlatformFor,
  formatZoom,
  normaliseSeed,
  platformIsExact,
  seedMapUrl,
} from "../src/minecraft/chunkbase";

/*
 * The Map page hands the operator a deep link into Chunkbase. Everything here is about that link being
 * right: the right platform for the Minecraft version the server runs, the real seed, and a shape the
 * seed-map app actually parses (`#seed=…&platform=…&dimension=…&x=…&z=…&zoom=…`).
 */
describe("chunkbase platform mapping", () => {
  test("an exact version maps to its own profile", () => {
    expect(chunkbasePlatformFor("1.21.4")).toBe("java_1_21_4");
    expect(chunkbasePlatformFor("1.20")).toBe("java_1_20");
    expect(chunkbasePlatformFor("1.21.9")).toBe("java_1_21_9");
  });

  test("a version with a patch the site has no profile for uses the newest older one", () => {
    // 1.21.7 has no profile; 1.21.9 must not be used (it predicts blocks that do not exist in 1.21.7).
    expect(chunkbasePlatformFor("1.21.7")).toBe("java_1_21_6");
    expect(chunkbasePlatformFor("1.21.1")).toBe("java_1_21");
  });

  test("patch-less and prefixed inputs both work", () => {
    expect(chunkbasePlatformFor("1.19")).toBe("java_1_19");
    expect(chunkbasePlatformFor("Paper 1.21.4")).toBe("java_1_21_4");
    expect(chunkbasePlatformFor("v1.8.9")).toBe("java_1_8");
  });

  test("a future version uses the newest known profile", () => {
    expect(chunkbasePlatformFor("26.3")).toBe("java_26_3");
    expect(chunkbasePlatformFor("27.1")).toBe("java_26_4");
  });

  test("junk and missing versions fall back instead of producing a broken link", () => {
    expect(chunkbasePlatformFor(null)).toBe("java_1_21_4");
    expect(chunkbasePlatformFor("")).toBe("java_1_21_4");
    expect(chunkbasePlatformFor("snapshot-24w14a")).toBe("java_1_21_4");
    expect(chunkbasePlatformFor("0.1")).toBe(CHUNKBASE_PLATFORMS[0]);
  });

  test("the panel can say whether the profile is exact", () => {
    expect(platformIsExact("1.21.4", "java_1_21_4")).toBe(true);
    expect(platformIsExact("1.21.7", "java_1_21_6")).toBe(false);
  });
});

describe("seed map url", () => {
  test("matches the shape the seed-map app parses", () => {
    const url = seedMapUrl({ seed: "2764310998248411735", platform: "java_26_3", dimension: "overworld", x: 0, z: 0, zoom: 0.5 });
    expect(url).toBe("https://www.chunkbase.com/apps/seed-map#seed=2764310998248411735&platform=java_26_3&dimension=overworld&x=0&z=0&zoom=0.5");
  });

  test("negative coordinates and other dimensions survive", () => {
    const url = seedMapUrl({ seed: "-4172144997902289642", platform: "java_1_21_4", dimension: "nether", x: -1024, z: 2048, zoom: 1 });
    expect(url).toContain("#seed=-4172144997902289642");
    expect(url).toContain("dimension=nether");
    expect(url).toContain("x=-1024");
    expect(url).toContain("z=2048");
    expect(url).toContain("zoom=1");
  });

  test("the seed travels in the fragment, so a browser never sends it to a server", () => {
    const url = seedMapUrl({ seed: "12345", platform: "java_1_21_4" });
    const [beforeHash, hash] = url.split("#");
    expect(hash.startsWith("seed=12345")).toBe(true);
    expect(beforeHash).not.toContain("12345");
  });

  test("fractional coordinates are rounded and text seeds are kept", () => {
    const url = seedMapUrl({ seed: "  my seed  ", platform: "java_1_21_4", x: 12.7, z: -4.2 });
    expect(url).toContain("seed=my+seed");
    expect(url).toContain("x=13");
    expect(url).toContain("z=-4");
  });
});

describe("seed and zoom normalisation", () => {
  test("whitespace in a text seed is collapsed, then encoded as + in the url", () => {
    expect(normaliseSeed("  hello   world ")).toBe("hello world");
    expect(seedMapUrl({ seed: "hello world", platform: "java_1_21_4" })).toContain("seed=hello+world");
  });

  test("zoom is clamped to the range the app accepts", () => {
    expect(formatZoom(0.5)).toBe("0.5");
    expect(formatZoom(0.01)).toBe("0.125");
    expect(formatZoom(99)).toBe("2");
    expect(formatZoom(Number.NaN)).toBe("0.5");
  });
});

/**
 * Chunkbase seed map integration.
 *
 * The Map page used to be only about BlueMap (a renderer that has to draw the *actual* world files).
 * That is honest but slow: a fresh server has nothing to render for hours. A seed map is different —
 * it is a prediction, computed by Chunkbase from the world seed and the game version, and it is
 * available the moment the world exists.
 *
 * Two facts shape this module:
 *
 *   1. **The seed is ours.** It is read from `level.dat` (see `readWorldSeed`), never typed in by the
 *      panel and never invented, so the map that opens is the map of *this* server's world.
 *   2. **Chunkbase cannot be embedded.** `www.chunkbase.com` sends `X-Frame-Options: DENY`, so every
 *      browser refuses to render it inside an `<iframe>`. RSLMC therefore builds the exact deep link
 *      and opens it in a new tab instead of shipping a frame that would show up blank.
 *
 * The platform ids (`java_1_21_4`, `java_26_3`, …) are the ones the seed-map app itself accepts; they
 * are listed in its own markup. `chunkbasePlatformFor()` maps a Minecraft version onto the closest
 * id that exists, because a panel can run a version the site has not published a profile for yet.
 */

const SEED_MAP_BASE = "https://www.chunkbase.com/apps/seed-map";

/** Platform ids the seed-map app accepts, oldest → newest. Kept as a list so mapping is testable. */
export const CHUNKBASE_PLATFORMS = [
  "java_1_7", "java_1_8", "java_1_9", "java_1_10", "java_1_11", "java_1_12", "java_1_13",
  "java_1_14", "java_1_15", "java_1_16", "java_1_17", "java_1_18", "java_1_19", "java_1_19_3",
  "java_1_20", "java_1_21", "java_1_21_2", "java_1_21_4", "java_1_21_5", "java_1_21_6",
  "java_1_21_9", "java_26_1", "java_26_2", "java_26_3", "java_26_4",
] as const;

export type ChunkbaseDimension = "overworld" | "nether" | "end";

export const CHUNKBASE_DIMENSIONS: Array<{ id: ChunkbaseDimension; label: string }> = [
  { id: "overworld", label: "Overworld" },
  { id: "nether", label: "Nether" },
  { id: "end", label: "End" },
];

/**
 * Turns "1.21.4" into an id the seed map understands.
 *
 * Exact match wins. Otherwise the *newest platform that is not newer than* the requested version is
 * used, so a 1.21.7 world is drawn with the 1.21.6 profile rather than with 1.21.9 (which would
 * predict blocks that do not exist in it). Older than every known id → the oldest one.
 */
export function chunkbasePlatformFor(mcVersion: string | null | undefined): string {
  const version = parseVersion(mcVersion);
  if (!version) return "java_1_21_4";
  const wanted = `java_${version.numbers.join("_")}`;
  if ((CHUNKBASE_PLATFORMS as readonly string[]).includes(wanted)) return wanted;

  let best: string | null = null;
  for (const platform of CHUNKBASE_PLATFORMS) {
    const parsed = parseVersion(platform.replace(/^java_/, "").replace(/_/g, "."));
    if (!parsed) continue;
    if (compareNumbers(parsed.numbers, version.numbers) <= 0) best = platform;
  }
  return best ?? CHUNKBASE_PLATFORMS[0];
}

/** True when the map will be drawn with a profile that is not exactly this version. */
export function platformIsExact(mcVersion: string | null | undefined, platform: string): boolean {
  const version = parseVersion(mcVersion);
  if (!version) return false;
  return platform === `java_${version.numbers.join("_")}`;
}

export interface SeedMapRequest {
  seed: string;
  platform: string;
  dimension?: ChunkbaseDimension;
  x?: number;
  z?: number;
  /** Chunkbase's own zoom scale: 0.25 is far out, 1 is close. */
  zoom?: number;
}

/** Builds the deep link the "Open seed map" button uses. */
export function seedMapUrl(request: SeedMapRequest): string {
  const seed = normaliseSeed(request.seed);
  const params = new URLSearchParams();
  params.set("seed", seed);
  params.set("platform", request.platform);
  params.set("dimension", request.dimension ?? "overworld");
  params.set("x", String(Math.round(request.x ?? 0)));
  params.set("z", String(Math.round(request.z ?? 0)));
  params.set("zoom", formatZoom(request.zoom ?? 0.5));
  return `${SEED_MAP_BASE}#${params.toString()}`;
}

/**
 * A seed is a 64-bit number or a text seed. Only whitespace is normalised — the URL encoder turns a
 * space into `+`, which is what the seed-map app reads back.
 */
export function normaliseSeed(seed: string): string {
  return seed.trim().replace(/\s+/g, " ");
}

/** Chunkbase accepts 0.25 / 0.5 / 1 … ; anything else is clamped into that range. */
export function formatZoom(zoom: number): string {
  if (!Number.isFinite(zoom)) return "0.5";
  const clamped = Math.min(2, Math.max(0.125, zoom));
  return String(Number(clamped.toFixed(3)));
}

/**
 * Only real version strings count: `1.21.4`, `Paper 1.21.4`, `v1.8.9`, `26.3`. A snapshot name such as
 * `24w14a` must not be read as "24.0.0", which would silently pick the wrong profile.
 */
function parseVersion(value: string | null | undefined): { numbers: number[] } | null {
  if (!value) return null;
  // `v1.8.9` and `Paper 1.21.4` are versions; `24w14a` is a snapshot name and is not.
  const text = value.trim().replace(/^v/i, "");
  const dotted = /(?:^|\s)(\d{1,2})\.(\d{1,2})(?:\.(\d+))?(?![\w.])/.exec(text);
  if (dotted) {
    return { numbers: [Number(dotted[1]), Number(dotted[2]), Number(dotted[3] ?? 0)] };
  }
  // A bare major version ("26") is only a version when nothing follows it.
  const bare = /^v?(\d{1,2})\s*$/.exec(text);
  return bare ? { numbers: [Number(bare[1]), 0, 0] } : null;
}

function compareNumbers(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

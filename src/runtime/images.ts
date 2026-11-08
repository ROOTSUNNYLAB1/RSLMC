import { dockerCommand, imagePresent } from "./docker";

/*
 * Which image runs which Java.
 *
 * Pterodactyl's `yolks` images are the reference point most Minecraft operators already know, and they
 * are built exactly for this: a small base with a JRE, a non-root user, and one tag per Java major.
 * The panel asks the registry which tags actually exist instead of hardcoding a guess — a hardcoded
 * `java_20` that was never published turns into "manifest unknown" at the worst possible moment, which
 * is right after somebody pressed Create.
 *
 * Ollama-free, honest fallback: when the registry cannot be reached (offline node, registry outage),
 * the panel falls back to `eclipse-temurin:<major>-jre`, which is where yolks gets its JDK anyway. The
 * UI shows which image will be used, so the choice is never a mystery.
 */

const GHCR_TOKEN_URL = "https://ghcr.io/token?scope=repository:pterodactyl/yolks:pull&service=ghcr.io";
const GHCR_TAGS_URL = "https://ghcr.io/v2/pterodactyl/yolks/tags/list";
const YOLKS_REPO = "ghcr.io/pterodactyl/yolks";

export interface JavaImage {
  major: number;
  /** The image that will actually be pulled. */
  reference: string;
  /** `yolks` when the registry lists the tag, `temurin` for the fallback. */
  source: "yolks" | "temurin";
  /** Human label for the wizard. */
  label: string;
  /** Present locally already? Filled by `describeImages`, false otherwise. */
  present: boolean;
}

/** The majors a server can be created with, Java 8 → 25. */
export const SUPPORTED_JAVA_MAJORS = [8, 11, 16, 17, 21, 22, 23, 24, 25] as const;

/** Every major in the 8–25 range, so odd versions (14, 18, 20) can still be selected explicitly. */
export const ALL_JAVA_MAJORS: number[] = Array.from({ length: 25 - 8 + 1 }, (_, index) => 8 + index);

let tagCache: { tags: Set<string>; at: number } | null = null;
const TAG_TTL_MS = 6 * 60 * 60_000;

/** Live tag list from GHCR. Cached for six hours; a failure is cached as "empty" for one minute. */
export async function yolksJavaTags(timeoutMs = 8000): Promise<Set<string>> {
  if (tagCache && Date.now() - tagCache.at < TAG_TTL_MS) return tagCache.tags;
  try {
    const tokenResponse = await fetch(GHCR_TOKEN_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!tokenResponse.ok) throw new Error(`token ${tokenResponse.status}`);
    const token = (await tokenResponse.json() as { token?: string }).token;
    if (!token) throw new Error("no token");
    const tagsResponse = await fetch(GHCR_TAGS_URL, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!tagsResponse.ok) throw new Error(`tags ${tagsResponse.status}`);
    const body = await tagsResponse.json() as { tags?: string[] };
    const tags = new Set(
      (body.tags ?? []).filter((tag) => /^java_\d+$/.test(tag)),
    );
    tagCache = { tags, at: Date.now() };
    return tags;
  } catch {
    // Retry sooner after a failure, but do not block the wizard on a registry that is down.
    tagCache = { tags: new Set(), at: Date.now() - TAG_TTL_MS + 60_000 };
    return tagCache.tags;
  }
}

/** Synchronous decision, given whatever the tag list currently holds. */
export function imageForMajor(major: number, yolksTags: Set<string>): JavaImage {
  const tag = `java_${major}`;
  if (yolksTags.has(tag)) {
    return {
      major,
      reference: `${YOLKS_REPO}:${tag}`,
      source: "yolks",
      label: `Pterodactyl yolks · Java ${major}`,
      present: false,
    };
  }
  return {
    major,
    reference: `eclipse-temurin:${major}-jre`,
    source: "temurin",
    label: `Eclipse Temurin · Java ${major}`,
    present: false,
  };
}

/** The image list the wizard shows: every supported major, with the live/local state filled in. */
export async function describeImages(majors: number[] = ALL_JAVA_MAJORS): Promise<JavaImage[]> {
  const tags = await yolksJavaTags();
  return majors.map((major) => {
    const image = imageForMajor(major, tags);
    return { ...image, present: imagePresent(image.reference) };
  });
}

/**
 * Ensures the image is on the machine before a container is created from it, and returns the
 * reference that should be used. Called from the start path, so a first start never fails with
 * "no such image" when a plain `docker pull` would have solved it.
 */
export async function ensureImage(
  major: number,
  onProgress?: (line: string) => void,
): Promise<JavaImage> {
  const tags = await yolksJavaTags();
  const image = imageForMajor(major, tags);
  if (imagePresent(image.reference)) return { ...image, present: true };
  const { pullImage } = await import("./docker");
  const result = await pullImage(image.reference, onProgress);
  if (!result.ok) {
    // A yolks image can fail for a private-registry reason: retry with the public JRE before giving up.
    if (image.source === "yolks") {
      const fallback = imageForMajor(major, new Set());
      onProgress?.(`${image.reference} could not be pulled (${result.message}); trying ${fallback.reference}.`);
      const second = await pullImage(fallback.reference, onProgress);
      if (second.ok) return { ...fallback, present: true };
      throw new Error(`${result.message}; fallback failed: ${second.message}`);
    }
    throw new Error(result.message);
  }
  return { ...image, present: true };
}

/* ------------------------------------------------------------------ */
/* Python / Node.js images                                             */
/* ------------------------------------------------------------------ */

let allTagCache: { tags: Set<string>; at: number } | null = null;

/**
 * Every tag in the yolks repository, not just the Java ones.
 *
 * yolks also publishes `python_3.7 … python_3.11` and `nodejs_12 … nodejs_20`. Those are the Pterodactyl
 * images the user asked to follow, so they are preferred; when a Python/Node line has no yolks tag the
 * official image is used and the panel says which one — it never invents a tag that was never pushed.
 */
export async function yolksAllTags(timeoutMs = 8000): Promise<Set<string>> {
  if (allTagCache && Date.now() - allTagCache.at < TAG_TTL_MS) return allTagCache.tags;
  try {
    const tokenResponse = await fetch(GHCR_TOKEN_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!tokenResponse.ok) throw new Error(`token ${tokenResponse.status}`);
    const token = (await tokenResponse.json() as { token?: string }).token;
    if (!token) throw new Error("no token");
    const tagsResponse = await fetch(GHCR_TAGS_URL, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!tagsResponse.ok) throw new Error(`tags ${tagsResponse.status}`);
    const body = await tagsResponse.json() as { tags?: string[] };
    const tags = new Set(body.tags ?? []);
    allTagCache = { tags, at: Date.now() };
    return tags;
  } catch {
    allTagCache = { tags: new Set(), at: Date.now() - TAG_TTL_MS + 60_000 };
    return allTagCache.tags;
  }
}

export interface AppImage {
  family: "python" | "node";
  version: string;
  reference: string;
  source: "yolks" | "official";
  label: string;
}

/**
 * The image for a Python/Node server.
 *
 * yolks first (`python_3.11`, `nodejs_20`), then the official slim image at the same line
 * (`python:3.13-slim`, `node:22-slim`). Newer lines are exactly the case this handles: yolks stops at
 * Python 3.11 and Node 20, so a panel that only knew yolks would silently lose Python 3.12+.
 */
export function appImageFor(family: "python" | "node", version: string, yolksTags: Set<string>): AppImage {
  const minor = version.split(".").slice(0, 2).join(".");
  const major = version.split(".")[0]!;
  const tag = family === "python" ? `python_${minor}` : `nodejs_${major}`;
  if (yolksTags.has(tag)) {
    return {
      family, version,
      reference: `${YOLKS_REPO}:${tag}`,
      source: "yolks",
      label: `Pterodactyl yolks · ${family === "python" ? "Python" : "Node.js"} ${family === "python" ? minor : major}`,
    };
  }
  return {
    family, version,
    reference: family === "python" ? `python:${minor}-slim` : `node:${major}-slim`,
    source: "official",
    label: `${family === "python" ? "Official python" : "Official node"} · ${family === "python" ? minor : major} (no yolks tag exists)`,
  };
}

/** True when the local Docker has any image whose reference contains this Java major. */
export function localImageForMajor(major: number): string | null {
  const result = dockerCommand(["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"], 15_000);
  if (!result.ok) return null;
  const lines = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const exact = lines.find((line) => line.endsWith(`:java_${major}`))
    ?? lines.find((line) => line.endsWith(`:${major}-jre`));
  return exact ?? null;
}

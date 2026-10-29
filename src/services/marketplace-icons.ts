import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PATHS } from "../shared/config";

/**
 * Modrinth project icons, fetched by the panel instead of the browser.
 *
 * The marketplace used to render `<img src="https://cdn.modrinth.com/…">` directly. On hosts behind a
 * reverse proxy, a restrictive network or an ad/tracker blocker, that request never completes and
 * every project tile shows a broken-image glyph — the catalogue looked like it had no logos at all.
 * The search itself works because the panel fetches the API server-side, so the fix is to fetch the
 * icon server-side too: the browser only ever talks to the panel.
 *
 * Guard rails: only `cdn.modrinth.com` over https, only image files, bounded size, short timeout, and
 * a disk cache so repeated page loads do not re-fetch from the CDN.
 */

const ALLOWED_HOSTS = new Set(["cdn.modrinth.com"]);
const MAX_BYTES = 512 * 1024;
const CACHE_DIR = join(PATHS.cache, "marketplace-icons");

export interface IconResult {
  body: Uint8Array;
  contentType: string;
}

function cachePathFor(url: string): string {
  return join(CACHE_DIR, `${createHash("sha256").update(url).digest("hex").slice(0, 32)}.bin`);
}

/** Only https Modrinth CDN image URLs are proxied; everything else is refused. */
export function isAllowedIconUrl(raw: string): boolean {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return false; }
  if (parsed.protocol !== "https:") return false;
  if (!ALLOWED_HOSTS.has(parsed.hostname)) return false;
  if (parsed.username || parsed.password) return false;
  return /\.(png|jpe?g|webp|gif|svg)$/i.test(parsed.pathname);
}

const memory = new Map<string, { body: Uint8Array; contentType: string; storedAt: number }>();
const MEMORY_LIMIT = 300;
const MEMORY_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Returns the image bytes for a Modrinth icon URL, or null when the URL is not allowed or the fetch
 * failed. Callers answer 404 in that case, which the UI turns into a letter tile.
 */
export async function fetchIcon(raw: string): Promise<IconResult | null> {
  if (!isAllowedIconUrl(raw)) return null;
  const cached = memory.get(raw);
  if (cached && Date.now() - cached.storedAt < MEMORY_TTL_MS) {
    return { body: cached.body, contentType: cached.contentType };
  }

  const disk = cachePathFor(raw);
  if (existsSync(disk)) {
    try {
      const body = readFileSync(disk);
      if (body.byteLength > 0 && body.byteLength <= MAX_BYTES) {
        const contentType = sniffType(body) ?? "image/png";
        remember(raw, body, contentType);
        return { body, contentType };
      }
    } catch { /* fall through to a fresh fetch */ }
  }

  try {
    const response = await fetch(raw, {
      headers: { "user-agent": "RSLMC panel (marketplace icon cache)" },
      signal: AbortSignal.timeout(8000),
      redirect: "follow",
    });
    if (!response.ok) return null;
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) return null;
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength === 0 || body.byteLength > MAX_BYTES) return null;
    const contentType = sniffType(body);
    // A redirect could have landed somewhere unexpected, and a CDN error page is not an image.
    if (!contentType) return null;
    try {
      if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true, mode: 0o750 });
      writeFileSync(disk, body);
    } catch { /* a read-only cache folder must not break the page */ }
    remember(raw, body, contentType);
    return { body, contentType };
  } catch {
    return null;
  }
}

function remember(url: string, body: Uint8Array, contentType: string): void {
  if (memory.size >= MEMORY_LIMIT) {
    const oldest = memory.keys().next().value;
    if (oldest) memory.delete(oldest);
  }
  memory.set(url, { body, contentType, storedAt: Date.now() });
}

/** Magic-byte check: the CDN may mislabel webp/png, and a non-image must never be served as one. */
function sniffType(body: Uint8Array): string | null {
  if (body.length < 12) return null;
  if (body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47) return "image/png";
  if (body[0] === 0xff && body[1] === 0xd8) return "image/jpeg";
  if (body[0] === 0x47 && body[1] === 0x49 && body[2] === 0x46) return "image/gif";
  // RIFF….WEBP
  if (body[0] === 0x52 && body[1] === 0x49 && body[2] === 0x46 && body[3] === 0x46
      && body[8] === 0x57 && body[9] === 0x45 && body[10] === 0x42 && body[11] === 0x50) return "image/webp";
  const head = new TextDecoder().decode(body.subarray(0, 256)).trim().toLowerCase();
  if (head.startsWith("<svg") || head.startsWith("<?xml")) return "image/svg+xml";
  return null;
}

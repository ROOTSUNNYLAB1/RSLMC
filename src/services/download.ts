import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, openSync, writeSync, writeFileSync, closeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { PATHS } from "../shared/config";
import { ApiException } from "../shared/http";
import { bus } from "../events/bus";

export interface DownloadOptions {
  url: string;
  destination: string;
  expectedSha256?: string | null;
  expectedSha1?: string | null;
  expectedSize?: number | null;
  label?: string;
  jobId?: string;
  serverId?: number | null;
  onProgress?: (received: number, total: number) => void;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface DownloadResult {
  path: string;
  size: number;
  sha256: string;
  sha1: string;
}

const ALLOWED_HOSTS = new Set<string>();

/** Only these hosts may be used for software/Java downloads (SSRF protection). */
const TRUSTED_HOST_PATTERNS = [
  /(^|\.)adoptium\.net$/,
  /(^|\.)adoptopenjdk\.net$/,
  /(^|\.)github\.com$/,
  /(^|\.)githubusercontent\.com$/,
  /(^|\.)papermc\.io$/,
  /(^|\.)purpurmc\.org$/,
  /(^|\.)mojang\.com$/,
  /(^|\.)fabricmc\.net$/,
  /(^|\.)quiltmc\.org$/,
  /(^|\.)neoforged\.net$/,
  /(^|\.)forgecdn\.net$/,
  /(^|\.)minecraftforge\.net$/,
  /(^|\.)md-5\.net$/,
  // Node.js servers: the official dist index and tarballs (round 57).
  /(^|\.)nodejs\.org$/,
  /(^|\.)modrinth\.com$/,
  /(^|\.)modrinth\.network$/,
  /(^|\.)cdn\.modrinth\.com$/,
];

export function assertTrustedUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ApiException(400, "invalid_url", "Malformed download URL");
  }
  if (url.protocol !== "https:") throw new ApiException(400, "invalid_url", "Only HTTPS downloads are permitted");
  const host = url.hostname.toLowerCase();
  // Block obvious internal targets even if a hostname pattern were ever loosened.
  if (["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"].includes(host) || /^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
    throw new ApiException(400, "invalid_url", "Downloads to internal addresses are not permitted");
  }
  const trusted = TRUSTED_HOST_PATTERNS.some((pattern) => pattern.test(host));
  if (!trusted && !ALLOWED_HOSTS.has(host)) {
    throw new ApiException(400, "untrusted_source", `Refusing to download from untrusted host: ${host}`);
  }
  return url;
}

async function hashFile(path: string, algorithm: "sha256" | "sha1"): Promise<string> {
  const hasher = createHash(algorithm);
  const stream = Bun.file(path).stream();
  for await (const chunk of stream as any) hasher.update(chunk);
  return hasher.digest("hex");
}

/**
 * Streams a download to a temporary file, verifies its checksum, then atomically renames it
 * into place. A partially downloaded file is never used or executed.
 */
/**
 * `fetch` with redirects followed manually, re-validating each hop.
 * Five hops is more than any of these CDNs use; anything longer is treated as a loop.
 */
async function fetchTrustedRedirects(url: URL, init: RequestInit, maxHops = 5): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= maxHops; hop += 1) {
    const response = await fetch(current, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new ApiException(502, "download_failed", `${current.hostname} redirected without a location`);
      let next: URL;
      try { next = new URL(location, current); } catch {
        throw new ApiException(502, "download_failed", `${current.hostname} redirected to an unparsable URL`);
      }
      current = assertTrustedUrl(next.toString());   // throws for http:, internal hosts, unknown domains
      continue;
    }
    return response;
  }
  throw new ApiException(502, "download_failed", `${url.hostname} redirected too many times`);
}

export async function downloadFile(options: DownloadOptions): Promise<DownloadResult> {
  const url = assertTrustedUrl(options.url);
  const destination = options.destination;
  mkdirSync(dirname(destination), { recursive: true });
  const tempPath = join(PATHS.temporary, `${randomUUID()}.part`);
  mkdirSync(PATHS.temporary, { recursive: true });

  const jobId = options.jobId ?? randomUUID();
  const publish = (progress: number, total: number, done: boolean, error?: string) => {
    options.onProgress?.(progress, total);
    bus.publish(`download:${jobId}`, {
      type: "progress",
      kind: "download",
      id: jobId,
      progress,
      total,
      label: options.label ?? "Download",
      done,
      error,
    });
    if (options.serverId) {
      bus.publish(`server:${options.serverId}`, {
        type: "progress",
        kind: "download",
        id: jobId,
        progress,
        total,
        label: options.label ?? "Download",
        done,
        error,
      });
    }
  };

  /*
   * Redirects are followed by hand so that every hop is validated by `assertTrustedUrl`. Vendor CDNs
   * redirect constantly (Mojang → piston-data, Modrinth → cdn.modrinth), and `redirect: "follow"`
   * meant only the *first* URL was checked: a 302 to `http://169.254.169.254/…` would have been
   * fetched without anyone looking at it.
   */
  let response: Response;
  try {
    response = await fetchTrustedRedirects(url, {
      headers: { "user-agent": "RSLMC/1.0 (+https://github.com/rslmc)", ...(options.headers ?? {}) },
      signal: options.signal,
    });
  } catch (err) {
    if (err instanceof ApiException) {
      publish(0, 0, true, err.message);
      throw err;
    }
    publish(0, 0, true, `Network error: ${err instanceof Error ? err.message : String(err)}`);
    throw new ApiException(502, "download_failed", `Could not reach ${url.hostname}`);
  }
  if (!response.ok || !response.body) {
    publish(0, 0, true, `HTTP ${response.status}`);
    throw new ApiException(502, "download_failed", `Download failed with HTTP ${response.status} for ${url.pathname}`);
  }

  const total = Number(response.headers.get("content-length") ?? options.expectedSize ?? 0);
  const sink = createWriteStream(tempPath);
  const hasher = createHash("sha256");
  const sha1Hasher = createHash("sha1");
  let received = 0;
  let lastPublish = 0;

  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      hasher.update(value);
      sha1Hasher.update(value);
      if (!sink.write(value)) {
        await new Promise<void>((resolve) => sink.once("drain", () => resolve()));
      }
      const now = Date.now();
      if (now - lastPublish > 250) {
        lastPublish = now;
        publish(received, total, false);
      }
    }
    await new Promise<void>((resolve, reject) => {
      sink.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    sink.destroy();
    try { rmSync(tempPath, { force: true }); } catch { /* ignore */ }
    publish(received, total, true, err instanceof Error ? err.message : "Download interrupted");
    throw new ApiException(502, "download_failed", `Download interrupted: ${err instanceof Error ? err.message : String(err)}`);
  }

  const sha256 = hasher.digest("hex");
  const sha1 = sha1Hasher.digest("hex");

  if (options.expectedSha256 && options.expectedSha256.toLowerCase() !== sha256) {
    rmSync(tempPath, { force: true });
    publish(received, total, true, "Checksum mismatch");
    throw new ApiException(502, "checksum_mismatch", `SHA-256 verification failed for ${url.pathname}`);
  }
  if (options.expectedSha1 && options.expectedSha1.toLowerCase() !== sha1) {
    rmSync(tempPath, { force: true });
    publish(received, total, true, "Checksum mismatch");
    throw new ApiException(502, "checksum_mismatch", `SHA-1 verification failed for ${url.pathname}`);
  }
  if (options.expectedSize && options.expectedSize > 0 && Math.abs(received - options.expectedSize) > 1024) {
    rmSync(tempPath, { force: true });
    publish(received, total, true, "Size mismatch");
    throw new ApiException(502, "size_mismatch", "Downloaded file size did not match the expected size");
  }

  if (existsSync(destination)) rmSync(destination, { force: true });
  renameSync(tempPath, destination);
  publish(received, received, true);
  return { path: destination, size: statSync(destination).size, sha256, sha1 };
}

/** Writes a JSON/text file atomically (used for generated configs). */
export function writeFileAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  // The temp file is created next to the target: a rename across filesystems (EXDEV) would fail, and
  // the temporary/ directory may well live on a different volume (e.g. a bind-mounted data root).
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const fd = openSync(temp, "w");
  try {
    writeSync(fd, contents);
  } finally {
    closeSync(fd);
  }
  try {
    if (existsSync(path)) rmSync(path, { force: true });
    renameSync(temp, path);
  } catch (err: any) {
    // Last resort for exotic filesystems that refuse renaming onto an existing file.
    if (err?.code !== "EXDEV" && err?.code !== "EPERM") throw err;
    writeFileSync(path, contents);
    rmSync(temp, { force: true });
  }
}

export async function fetchJson<T>(url: string, timeoutMs = 15_000): Promise<T> {
  const target = assertTrustedUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(target, {
      headers: { "user-agent": "RSLMC/1.0", accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ApiException(502, "upstream_error", `Upstream API returned HTTP ${response.status}`, { url });
    }
    return (await response.json()) as T;
  } catch (err) {
    if (err instanceof ApiException) throw err;
    throw new ApiException(502, "upstream_unreachable", `Could not reach upstream API: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

import { existsSync, mkdirSync, readdirSync, statSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT_DIR, FRONTEND_DIR, MODE } from "../shared/config";

const OUT_DIR = join(ROOT_DIR, "public", "dist");
const FRONTEND_ENTRY = join(FRONTEND_DIR, "index.html");

let lastBuild = 0;
let lastBuildAttempt = 0;

/** Bundles the React frontend with Bun's bundler. Runs at boot and on demand in dev. */
export async function buildFrontend(force = false): Promise<{ ok: boolean; durationMs: number; error?: string }> {
  const started = Date.now();
  if (!existsSync(FRONTEND_ENTRY)) {
    return { ok: false, durationMs: 0, error: "frontend/index.html is missing" };
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const result = await Bun.build({
    entrypoints: [FRONTEND_ENTRY],
    outdir: OUT_DIR,
    target: "browser",
    minify: MODE === "production",
    sourcemap: MODE === "production" ? "none" : "linked",
    splitting: false,
    naming: "[name].[ext]",
    define: {
      "process.env.NODE_ENV": JSON.stringify(MODE === "production" ? "production" : "development"),
    },
    loader: { ".woff2": "file", ".png": "file", ".svg": "file" },
  });

  if (!result.success) {
    const messages = result.logs.map((log) => String(log)).join("\n");
    console.error("[rslmc] frontend build failed:\n" + messages);
    return { ok: false, durationMs: Date.now() - started, error: messages.slice(0, 4000) };
  }

  // Static assets referenced by absolute URL (fonts) are copied verbatim.
  const assetsDir = join(FRONTEND_DIR, "assets");
  if (existsSync(assetsDir)) {
    cpSync(assetsDir, join(OUT_DIR, "assets"), { recursive: true });
  }
  lastBuild = Date.now();
  return { ok: true, durationMs: Date.now() - started };
}

/**
 * Rebuilds on demand when the bundle is missing.
 *
 * `public/dist` is generated output: it can be wiped by a deploy step, a container image that only
 * copies the source, or a build that failed at boot. Without this the panel answered every page
 * request with "Not found" — the API stayed healthy, so it looked like only the UI had broken.
 * Debounced to one attempt every two seconds so a burst of requests cannot start a build storm.
 */
export async function ensureFrontendBuilt(): Promise<boolean> {
  if (existsSync(join(OUT_DIR, "index.html"))) return true;
  if (Date.now() - lastBuildAttempt < 2000) return false;
  lastBuildAttempt = Date.now();
  const result = await buildFrontend(true);
  return result.ok;
}

export function frontendBuildError(): string | null {
  return existsSync(join(OUT_DIR, "index.html")) ? null : "The frontend bundle is missing from public/dist.";
}

export function staticFile(pathname: string): { file: Bun.BunFile; contentType: string } | null {
  const safe = pathname.replace(/\.\./g, "").replace(/\/+/g, "/");
  const candidates = [
    join(OUT_DIR, safe),
    join(OUT_DIR, safe, "index.html"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return { file: Bun.file(candidate), contentType: contentTypeFor(candidate) };
    }
  }
  // SPA fallback for client-side routes.
  const index = join(OUT_DIR, "index.html");
  if (!safe.includes(".") && existsSync(index)) {
    return { file: Bun.file(index), contentType: "text/html; charset=utf-8" };
  }
  return null;
}

function contentTypeFor(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    html: "text/html; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    css: "text/css; charset=utf-8",
    json: "application/json; charset=utf-8",
    woff2: "font/woff2",
    woff: "font/woff",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    ico: "image/x-icon",
    map: "application/json",
    txt: "text/plain; charset=utf-8",
  };
  return map[extension] ?? "application/octet-stream";
}

export function distExists(): boolean {
  return existsSync(join(OUT_DIR, "index.html"));
}

export function buildTimestamp(): number {
  return lastBuild;
}

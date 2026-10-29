import { PORT, HOST, MODE, APP_VERSION, PATHS, DATA_LOCATION, adoptLegacyDataDir, ensureDirectories, loadAppSecret } from "./shared/config";
import { getDb, closeDb } from "./database";
import { bootstrap, needsSetup } from "./services/bootstrap";
import { buildFrontend, ensureFrontendBuilt, staticFile } from "./services/frontend-build";
import { handleApiRequest, describeRoutes } from "./api";
import { upgradeWebSocket, websocketHandlers, startWsHeartbeat, wsStats } from "./api/ws";
import { startScheduler, stopScheduler } from "./services/schedules";
import { reconcileForeignProcesses, shutdownAll, waitForIdle } from "./processes/manager";
import { hostStats } from "./resources/host";
import { detectCgroups } from "./resources/cgroups";
import { startAutoStartServers } from "./services/autostart";
import { pruneGhostServers } from "./services/servers";

async function main(): Promise<void> {
  const bootStarted = Date.now();
  // Adopt a data folder created by an older build (<app>/runtime) into the platform location
  // (/opt/rslmc on Linux, %ProgramData%\RSLMC on Windows) before anything touches the database.
  const adopted = adoptLegacyDataDir();
  if (adopted.note) console.log(`[rslmc] ${adopted.note}`);
  ensureDirectories();
  if (DATA_LOCATION.note) console.warn(`[rslmc] ${DATA_LOCATION.note}`);
  loadAppSecret();
  getDb();
  // Before bootstrap(): its reconcile marks stale 'installing' rows as offline, which would hide
  // the unfinished records that pruneGhostServers() is meant to remove.
  pruneGhostServers();
  // Captured before bootstrap() seeds the admin account, otherwise a fresh install would already
  // look like an existing one in the startup banner.
  const freshInstall = needsSetup();
  await bootstrap();
  const build = await buildFrontend();
  if (!build.ok) {
    console.error("[rslmc] The frontend failed to build — the panel UI will not be available until it is fixed.");
  }

  // A server started before a panel restart has no entry in the process table; adopt it so the UI
  // reports "recovering" instead of the stale status persisted in SQLite (often a failed install).
  try {
    const reconciled = reconcileForeignProcesses();
    if (reconciled.adopted > 0) console.log(`[rslmc] adopted ${reconciled.adopted} server process(es) started outside the panel`);
  } catch (error) {
    console.error(`[rslmc] orphan reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  setInterval(() => {
    try { reconcileForeignProcesses(); } catch { /* transient /proc or PowerShell failure */ }
  }, 15_000).unref?.();

  const cgroups = detectCgroups();
  const stats = hostStats();

  /**
 * Hardening headers for every response the panel produces.
 *
 * The API branch used to set `x-frame-options`/`referrer-policy` only, which meant the actual HTML
 * document — the thing a browser renders — had neither, so the panel could be framed by any site and
 * there was no CSP to blunt an injected script. The CSP below is deliberately explicit: the bundle is
 * a real file (`script-src 'self'`), fonts are self-hosted, and inline styles are allowed because the
 * React components set style attributes. `frame-ancestors 'none'` also covers modern browsers that
 * ignore X-Frame-Options.
 */
function applySecurityHeaders(response: Response, opts: { document?: boolean } = {}): Response {
  const headers = response.headers;
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "same-origin");
  headers.set("x-content-type-options", "nosniff");
  headers.set("permissions-policy", "geolocation=(), microphone=(), camera=(), payment=()");
  if (opts.document) headers.set("content-security-policy", CONTENT_SECURITY_POLICY);
  return response;
}

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  // React sets style attributes; the bundled CSS is a file.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const server = Bun.serve({
    port: PORT,
    hostname: HOST,
    development: MODE === "development",
    maxRequestBodySize: 2 * 1024 * 1024 * 1024,
    idleTimeout: 60,
    fetch: async (req, srv) => {
      const url = new URL(req.url);

      // WebSocket endpoint — authenticated with the session cookie.
      if (url.pathname === "/ws") {
        const ip = srv.requestIP(req)?.address ?? "unknown";
        const upgraded = upgradeWebSocket(req, srv, url);
        if (upgraded) return upgraded;
        return new Response(null, { status: 101 });
      }

      if (url.pathname.startsWith("/api/")) {
        const ip = srv.requestIP(req)?.address ?? "unknown";
        const response = await handleApiRequest(req, url, ip);
        if (response) {
          response.headers.set("x-rslmc-version", APP_VERSION);
          return applySecurityHeaders(response);
        }
        return Response.json({ error: { code: "not_found", message: `No API route for ${req.method} ${url.pathname}` } }, { status: 404 });
      }

      if (req.method === "GET" || req.method === "HEAD") {
        const asset = staticFile(url.pathname);
        if (asset) {
          return applySecurityHeaders(new Response(asset.file, {
            headers: {
              "content-type": asset.contentType,
              "cache-control": url.pathname === "/" ? "no-cache" : "public, max-age=3600",
              "x-content-type-options": "nosniff",
            },
          }), { document: asset.contentType.startsWith("text/html") });
        }
      }
      // No asset on disk: rebuild once and retry before giving up on a page request.
      if (req.method === "GET" && !/\.(?:js|css|map|png|svg|woff2?|ico)$/.test(url.pathname)) {
        if (await ensureFrontendBuilt()) {
          const rebuilt = staticFile(url.pathname);
          if (rebuilt) {
            return applySecurityHeaders(new Response(rebuilt.file, {
              headers: { "content-type": rebuilt.contentType, "cache-control": "no-cache", "x-content-type-options": "nosniff" },
            }), { document: rebuilt.contentType.startsWith("text/html") });
          }
        }
        return new Response(
          `<!doctype html><meta charset="utf-8"><title>RSLMC</title>`
          + `<div style="font:14px/1.6 system-ui,sans-serif;color:#e8e8ee;background:#0b0b0e;padding:48px">`
          + `<strong>RSLMC is rebuilding the panel UI.</strong><p>The API is running normally. `
          + `Reload in a few seconds — if this persists, the last frontend build failed and the panel log has the compiler output.</p></div>`,
          { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
        );
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: websocketHandlers,
    error(error) {
      console.error("[rslmc] server error", error);
      return Response.json({ error: { code: "internal_error", message: "Internal server error" } }, { status: 500 });
    },
  });

  startWsHeartbeat();
  startScheduler();
  await startAutoStartServers();

  const bootMs = Date.now() - bootStarted;
  const lines = [
    "",
    "  ██████╗ ███████╗██╗     ███╗   ███╗ ██████╗",
    "  ██╔══██╗██╔════╝██║     ████╗ ████║██╔════╝",
    "  ██████╔╝███████╗██║     ██╔████╔██║██║     ",
    "  ██╔══██╗╚════██║██║     ██║╚██╔╝██║██║     ",
    "  ██║  ██║███████║███████╗██║ ╚═╝ ██║╚██████╗",
    "  ╚═╝  ╚═╝╚══════╝╚══════╝╚═╝     ╚═╝ ╚═════╝",
    "",
    `  RSLMC ${APP_VERSION} — Minecraft server management panel`,
    `  Mode          ${MODE}`,
    `  Listening     http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${server.port}`,
    `  Data          ${PATHS.data} (${DATA_LOCATION.source})`,
    `  Bun           ${Bun.version} (${stats.os}, ${stats.cpuCores} cores, ${(stats.memoryTotalBytes / 1024 ** 3).toFixed(1)} GiB RAM)`,
    `  Enforcement   memory/CPU: ${cgroups.privileged ? "cgroup v2 (kernel-enforced)" : "advisory (no privileged cgroups)"}`,
    `  API routes    ${describeRoutes().length}`,
    `  Boot time     ${bootMs} ms${build.ok ? ` (frontend built in ${build.durationMs} ms)` : " (frontend build FAILED)"}`,
    freshInstall
      ? "  Setup         First run — bootstrap admin 'admin' / 'admin123' created; the panel forces a password change."
      : "  Setup         Existing installation detected.",
    "",
  ];
  console.log(lines.join("\n"));

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[rslmc] ${signal} received — stopping servers and closing the panel…`);
    stopScheduler();
    shutdownAll();
    // Give running servers the chance to stop gracefully before the panel exits (bounded).
    await waitForIdle(9000);
    server.stop(true);
    await new Promise((resolve) => setTimeout(resolve, 400));
    closeDb();
    console.log("[rslmc] Shutdown complete.");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

process.on("unhandledRejection", (reason) => {
  console.error("[rslmc] unhandled rejection:", reason);
});

main().catch((error) => {
  console.error("[rslmc] Fatal startup error:", error);
  process.exit(1);
});

export { wsStats };

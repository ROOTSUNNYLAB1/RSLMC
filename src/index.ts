import { PORT, HOST, MODE, APP_VERSION, PATHS, DATA_LOCATION, adoptLegacyDataDir, ensureDirectories, loadAppSecret } from "./shared/config";
import { getDb, closeDb } from "./database";
import { bootstrap, needsSetup } from "./services/bootstrap";
import { buildFrontend, ensureFrontendBuilt, staticFile } from "./services/frontend-build";
import { handleApiRequest, describeRoutes } from "./api";
import { loadDockerConfig } from "./api/panel-routes";
import { upgradeWebSocket, websocketHandlers, startWsHeartbeat, wsStats } from "./api/ws";
import { startScheduler, stopScheduler } from "./services/schedules";
import { adoptRelays, handOffForPanelRestart, reconcileContainers, reconcileForeignProcesses, runningServerCount, shutdownAll, waitForIdle } from "./processes/manager";
import { probeDocker } from "./runtime/docker";
import { completeRestartOnBoot, registerRestartHandlers } from "./update/restart";
import { startUpdateWatcher, stopUpdateWatcher } from "./update/service";
import { hostStats } from "./resources/host";
import { detectCgroups } from "./resources/cgroups";
import { startAutoStartServers } from "./services/autostart";
import { pruneGhostServers } from "./services/servers";
import { startNodeHeartbeats, stopNodeHeartbeats } from "./nodes/heartbeat";

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
  // A Docker endpoint saved from the panel must be in force before the first probe, otherwise the
  // wizard would report "not available" for one page load after a restart and look broken.
  loadDockerConfig();
  // Before bootstrap(): its reconcile marks stale 'installing' rows as offline, which would hide
  // the unfinished records that pruneGhostServers() is meant to remove.
  pruneGhostServers();
  // Captured before bootstrap() seeds the admin account, otherwise a fresh install would already
  // look like an existing one in the startup banner.
  const freshInstall = needsSetup();
  await bootstrap();
  /*
   * A failed frontend build must not stop the panel from starting. It happened for real: a panel run
   * once as root left root-owned files in public/dist, the next non-root boot could not rewrite them,
   * and the thrown permission error took the whole process down — taking every running server with it.
   * The API is still correct without a fresh bundle, so this is a warning, not a fatal error.
   */
  let build: { ok: boolean; durationMs: number; error?: string } = { ok: false, durationMs: 0 };
  try {
    build = await buildFrontend();
  } catch (error) {
    build = { ok: false, durationMs: 0, error: error instanceof Error ? error.message : String(error) };
  }
  if (!build.ok) {
    console.error(`[rslmc] The frontend failed to build — the panel UI will not be available until it is fixed.${build.error ? ` (${build.error})` : ""}`);
  }

  /*
   * Warm the Python/Node version lists in the background.
   *
   * Listing them is a handful of upstream requests (nodejs.org's index plus the release assets of a few
   * python-build-standalone tags) and takes a few seconds cold. Doing it here means the create wizard's
   * software step already has the lists when an operator opens it, instead of showing "loading…" for the
   * first five seconds after a panel start. A failure is not fatal: the wizard asks again and reports it.
   */
  void (async () => {
    try {
      const { describeApps } = await import("./apps/catalog");
      const apps = await describeApps();
      const summary = apps.map((app) => `${app.name}: ${app.error ? "unavailable" : `${app.versions.length} versions`}`).join(", ");
      console.log(`[rslmc] runtime catalogue warmed — ${summary}`);
    } catch (error) {
      console.warn(`[rslmc] runtime catalogue could not be warmed: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();

  /*
   * Servers survive a panel restart inside their relays. Reconnect to them *before* the orphan scan,
   * so they come back as fully managed (console and all) instead of merely "running but unmanaged".
   */
  try {
    const relays = await adoptRelays();
    if (relays.adopted > 0) console.log(`[rslmc] reattached to ${relays.adopted} running server(s) that outlived the panel`);
    if (relays.failed > 0) console.warn(`[rslmc] ${relays.failed} relay(s) could not be reattached — see the server console`);
  } catch (error) {
    console.error(`[rslmc] relay adoption failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // A server started before a panel restart has no entry in the process table; adopt it so the UI
  // reports "recovering" instead of the stale status persisted in SQLite (often a failed install).
  try {
    const reconciled = reconcileForeignProcesses();
    if (reconciled.adopted > 0) console.log(`[rslmc] adopted ${reconciled.adopted} server process(es) started outside the panel`);
  } catch (error) {
    console.error(`[rslmc] orphan reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  /*
   * Containers outlive the panel too, and they cannot be found by scanning /proc. Once at boot (and
   * only when the daemon answers) the panel asks Docker what is still running, so a container server
   * shows "recovering" instead of the stale status left in SQLite.
   */
  const reconcileDockerOnce = () => {
    try {
      const docker = probeDocker();
      if (!docker.available) return;
      const result = reconcileContainers();
      if (result.running > 0) console.log(`[rslmc] ${result.running} Docker container server(s) are still running`);
    } catch (error) {
      console.error(`[rslmc] container reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  reconcileDockerOnce();

  setInterval(() => {
    try { reconcileForeignProcesses(); } catch { /* transient /proc or PowerShell failure */ }
  }, 15_000).unref?.();

  // Remote nodes: handshake every 15 s, server inventory every 5 s (see nodes/heartbeat.ts).
  startNodeHeartbeats();

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
function applySecurityHeaders(response: Response, opts: { document?: boolean; userContent?: boolean } = {}): Response {
  const headers = response.headers;
  headers.set("x-content-type-options", "nosniff");
  headers.set("permissions-policy", "geolocation=(), microphone=(), camera=(), payment=()");
  if (opts.userContent) {
    /*
     * Files the panel did not author — a world renderer's web output lives in the server's own data
     * directory, so any account with `server.files` can put an `index.html` (or edit BlueMap's) there.
     * Served as-is on the panel's origin, that is stored XSS with the viewer's session attached: the
     * script could read the CSRF token and act as an administrator.
     *
     * The fix is an opaque origin: CSP `sandbox` *without* `allow-same-origin` gives the document a
     * unique origin, so its fetches to /api/* are cross-origin (no CORS rules are added for the API,
     * so they fail), and it cannot read the panel's cookies or storage. Scripts, styles and assets
     * still load — the directives below name the schemes explicitly because `'self'` matches nothing
     * from an opaque origin. `x-frame-options: SAMEORIGIN` (not DENY) lets the Map page embed it.
     */
    headers.set("content-security-policy", USER_CONTENT_POLICY);
    headers.set("x-frame-options", "SAMEORIGIN");
    headers.set("referrer-policy", "no-referrer");
    headers.set("cross-origin-resource-policy", "cross-origin");
    headers.set("access-control-allow-origin", "*");
    return response;
  }
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "same-origin");
  if (opts.document) headers.set("content-security-policy", CONTENT_SECURITY_POLICY);
  return response;
}

/** CSP for renderer output (see `userContent` above): sandboxed, no same-origin, no panel access. */
const USER_CONTENT_POLICY = [
  "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock",
  "default-src https: http: data: blob:",
  "script-src https: http: data: blob: 'unsafe-inline' 'unsafe-eval'",
  "style-src https: http: data: blob: 'unsafe-inline'",
  "img-src https: http: data: blob:",
  "font-src https: http: data:",
  "connect-src https: http: data: blob: ws: wss:",
  "worker-src https: http: data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * Extra script origins, opt-in only.
 *
 * The panel ships a strict `script-src 'self'`. A proxy that rewrites the HTML — Cloudflare's Web
 * Analytics injects `static.cloudflareinsights.com/beacon.min.js` at the edge — is then blocked by
 * design, and the browser logs a CSP violation while the panel itself works fine. The right fix is
 * to turn that injection off, but an operator who wants it can list the origin explicitly:
 *
 *   RSLMC_CSP_SCRIPT_SRC=https://static.cloudflareinsights.com
 *
 * Nothing is allowed by default, the value is validated as an origin list, and boot logs a warning
 * so nobody widens the policy by accident.
 */
function scriptSrcOrigins(): string {
  const raw = (process.env.RSLMC_CSP_SCRIPT_SRC ?? "").trim();
  if (!raw) return "";
  const accepted: string[] = [];
  for (const candidate of raw.split(",").map((value) => value.trim()).filter(Boolean)) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;
      accepted.push(candidate.replace(/\/+$/, ""));
    } catch {
      console.log(`[rslmc] ignoring RSLMC_CSP_SCRIPT_SRC entry that is not a URL: ${candidate}`);
    }
  }
  if (accepted.length === 0) return "";
  console.log(
    `[rslmc] CSP widened for script-src: ${accepted.join(", ")} — every script from these origins may run ` +
    "in the panel. Prefer disabling the proxy's script injection instead.",
  );
  return ` ${accepted.join(" ")}`;
}

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self'${scriptSrcOrigins()}`,
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
        // Renderer output is user content, not panel content: isolated origin, frameable by the panel.
        const userContent = /^\/api\/servers\/\d+\/map\/web(\/|$)/.test(url.pathname);
        const response = await handleApiRequest(req, url, ip);
        if (response) {
          response.headers.set("x-rslmc-version", APP_VERSION);
          return applySecurityHeaders(response, { userContent });
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
    // Console sockets only carry commands and metrics: cap a frame instead of buffering anything.
    websocket: { ...websocketHandlers, maxPayloadLength: 64 * 1024 },
    error(error) {
      console.error("[rslmc] server error", error);
      return Response.json({ error: { code: "internal_error", message: "Internal server error" } }, { status: 500 });
    },
  });

  /*
   * Restart plumbing. The panel can relaunch itself; the handler below is the *only* way it does so,
   * and it deliberately does not call shutdownAll(): running servers are handed to their relays, so
   * they never notice the panel was gone.
   */
  registerRestartHandlers({
    handOff: () => handOffForPanelRestart(),
    async shutdown() {
      stopUpdateWatcher();
      stopScheduler();
      server.stop(true);
      await new Promise((resolve) => setTimeout(resolve, 350));
      closeDb();
      console.log("[rslmc] Restart handoff complete — the relauncher will start a new panel process.");
      process.exit(0);
    },
  });

  // Close the loop on a restart that happened before this process booted (timings, notifications).
  let justRestarted = false;
  try {
    const completed = completeRestartOnBoot(runningServerCount());
    justRestarted = completed.restarted;
    if (completed.restarted) {
      console.log(`[rslmc] this boot completed a panel restart${completed.bootMs !== null ? ` (${completed.bootMs} ms)` : ""}; ${completed.serversKept} server(s) were kept running`);
    }
  } catch (error) {
    console.error(`[rslmc] restart bookkeeping failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  startWsHeartbeat();
  startScheduler();
  // A restart usually follows an install, and the installer deliberately forgets the release it
  // applied — so re-read the feed in a second instead of leaving the badge blank for a minute.
  startUpdateWatcher({ checkNow: justRestarted });
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
      ? "  Setup         First run — bootstrap admin 'admin' / 'admin123' created. It is not forced to change: "
        + "change it in My Profile (and see SECURITY.md) before exposing this panel."
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
    stopUpdateWatcher();
    stopNodeHeartbeats();
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

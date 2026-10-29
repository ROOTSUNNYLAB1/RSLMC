import { Router, json, validate, v, forbidden, ApiException } from "../shared/http";
import { requirePermission, hasPermission, permissionsForUser } from "../auth";
import { APP_VERSION, DATA_LOCATION, MODE, PORT, PATHS, ROOT_DIR } from "../shared/config";
import { compareCalVer, describeReleaseAge, parseCalVer } from "../shared/calver";
import { hostStats, diskUsage } from "../resources/host";
import { describeEnforcement } from "../resources/enforcement";
import { detectCgroups } from "../resources/cgroups";
import { describeRoutes } from "./index";
import { recordActivity } from "../services/audit";
import {
  checkForUpdates, dismissUpdate, getSettings, saveSettings, snapshot, type UpdateSnapshot,
} from "../update/service";
import { latestJob, recentJobs, startInstall } from "../update/installer";
import { panelUptimeSeconds, requestPanelRestart, restartSnapshot } from "../update/restart";
import {
  listAvailableVersions, fetchRepositoryInfo, repositorySlug, repositoryUrl,
  type GitHubRelease, type RepositoryInfo,
} from "../update/github";

/**
 * Panel-level routes: everything the About page needs, plus the update and restart controls.
 *
 * Permission model:
 *  - reading the panel's build/version and the restart history: any signed-in account (it is not a
 *    secret, and a `User` should be able to see which panel version they are using);
 *  - checking, installing, changing update settings and restarting the panel: `system.manage`, i.e.
 *    administrators. A server-scoped role cannot restart infrastructure it does not own.
 */

const ADMIN_PERMISSION = "system.manage";

function requireAdmin(user: any) {
  requirePermission(user, ADMIN_PERMISSION);
}

function canManage(user: any): boolean {
  return hasPermission(user, ADMIN_PERMISSION);
}

/* ------------------------------------------------------------------ */
/* GitHub repository info + release list (cached, never blocks boot)    */
/* ------------------------------------------------------------------ */

interface RepoCache {
  info: RepositoryInfo | null;
  error: string | null;
  releases: GitHubRelease[];
  fetchedAt: number;
}

let repoCache: RepoCache = { info: null, error: null, releases: [], fetchedAt: 0 };
let repoFetch: Promise<void> | null = null;
const REPO_TTL_MS = 10 * 60_000;

async function refreshRepositoryInfo(force = false): Promise<void> {
  if (!force && Date.now() - repoCache.fetchedAt < REPO_TTL_MS) return;
  if (repoFetch) return repoFetch;
  repoFetch = (async () => {
    try {
      const [info, versions] = await Promise.all([
        fetchRepositoryInfo(),
        listAvailableVersions({ includePrerelease: true }),
      ]);
      repoCache = { info, error: null, releases: versions.items.slice(0, 6), fetchedAt: Date.now() };
    } catch (error) {
      repoCache = {
        ...repoCache,
        error: error instanceof Error ? error.message : String(error),
        fetchedAt: Date.now(),
      };
    } finally {
      repoFetch = null;
    }
  })();
  return repoFetch;
}

/** Everything the About page renders in one round-trip. */
export function aboutPayload(user: any) {
  const stats = hostStats();
  const cgroups = detectCgroups();
  const disk = diskUsage();
  const update = snapshot();
  const restart = restartSnapshot();
  const settings = getSettings();
  const job = latestJob();
  const updaterCanManage = canManage(user);
  return {
    version: APP_VERSION,
    versionIsCalVer: Boolean(parseCalVer(APP_VERSION)),
    build: {
      mode: MODE,
      port: PORT,
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      uptimeSeconds: panelUptimeSeconds(),
      startedAt: new Date(Date.now() - panelUptimeSeconds() * 1000).toISOString(),
      routes: describeRoutes().length,
      javaArch: stats.os,
      cpuCores: stats.cpuCores,
      memoryTotalBytes: stats.memoryTotalBytes,
    },
    paths: {
      root: ROOT_DIR,
      data: PATHS.data,
      dataSource: DATA_LOCATION.source,
      dataNote: DATA_LOCATION.note,
      database: PATHS.dbFile,
      backups: PATHS.backups,
    },
    enforcement: describeEnforcement(cgroups),
    disk: { usedBytes: disk.usedBytes, freeBytes: disk.freeBytes, totalBytes: disk.totalBytes },
    update: {
      ...update,
      // Notes can be long; the UI renders markdown-lite, so send them whole but bounded.
      latest: update.latest ? { ...update.latest, notes: update.latest.notes.slice(0, 20_000) } : null,
      job,
      history: recentJobs(5),
      settings,
      canManage: updaterCanManage,
      source: update.source,
    },
    restart: {
      ...restart,
      canManage: updaterCanManage,
    },
    repository: {
      slug: repositorySlug(),
      url: repositoryUrl(),
      info: repoCache.info,
      error: repoCache.error,
      releases: repoCache.releases.map((release) => ({
        version: release.version,
        name: release.name,
        url: release.url,
        publishedAt: release.publishedAt,
        prerelease: release.prerelease,
        age: describeReleaseAge(release.version),
        notes: release.notes.slice(0, 4000),
        isCurrent: compareCalVer(release.version, APP_VERSION) === 0,
        isNewer: compareCalVer(release.version, APP_VERSION) > 0,
      })),
    },
    credits: {
      license: "MIT",
      stack: [
        { name: "Bun", role: "runtime, HTTP server, WebSocket, SQLite driver" },
        { name: "TypeScript", role: "panel backend and UI, strict mode" },
        { name: "React 19", role: "single-page frontend served by the same process" },
        { name: "SQLite", role: "one database file in the data folder, WAL mode" },
        { name: "Eclipse Temurin", role: "Java 8–25 runtimes installed by the panel" },
        { name: "Modrinth", role: "plugin and mod catalogue" },
      ],
      acknowledgements: [
        "Mojang for the vanilla server and version manifest",
        "PaperMC, Purpur, Fabric, Quilt, Forge and NeoForge for their server APIs",
        "The Pterodactyl project for showing what a game panel should feel like",
      ],
    },
  };
}

const updateSettingsSchema = {
  autoCheck: v.boolean({ optional: true }),
  includePrerelease: v.boolean({ optional: true }),
  intervalMinutes: v.number({ min: 30, max: 1440, optional: true }),
};

export function registerPanelRoutes(router: Router): void {
  /* --- About ---------------------------------------------------------- */
  router.get("/api/panel/about", async (ctx) => {
    /*
     * The first render waits (briefly) for GitHub so the page is not born with empty star counts;
     * after that the cache is served immediately and refreshed in the background. GitHub being down
     * must never make About hang, hence the 4 s cap and the cached fallback.
     */
    if (!repoCache.info && !repoCache.error) {
      await Promise.race([
        refreshRepositoryInfo(),
        new Promise((resolve) => setTimeout(resolve, 4000)),
      ]);
    } else {
      void refreshRepositoryInfo();
    }
    return json(aboutPayload(ctx.user));
  });

  router.post("/api/panel/about/refresh", async (ctx) => {
    await refreshRepositoryInfo(true);
    return json(aboutPayload(ctx.user));
  });

  /* --- Update state --------------------------------------------------- */
  router.get("/api/panel/update", async (ctx) => {
    const data: UpdateSnapshot & { canManage: boolean; job: unknown } = {
      ...snapshot(),
      canManage: canManage(ctx.user),
      job: latestJob(),
    };
    return json(data);
  });

  router.post("/api/panel/update/check", async (ctx) => {
    requireAdmin(ctx.user);
    const result = await checkForUpdates({ force: true, actor: ctx.user!.username });
    recordActivity({
      type: "panel.update_checked", actorName: ctx.user!.username, target: "panel",
      metadata: { latest: result.latest?.version ?? null, current: APP_VERSION },
    });
    return json({ ...result, job: latestJob(), canManage: true });
  });

  router.patch("/api/panel/update/settings", async (ctx) => {
    requireAdmin(ctx.user);
    const body = validate(updateSettingsSchema, await ctx.body());
    const saved = saveSettings(body);
    recordActivity({
      type: "panel.update_settings", actorName: ctx.user!.username, target: "panel", metadata: { ...saved },
    });
    return json({ settings: saved, update: snapshot() });
  });

  router.post("/api/panel/update/dismiss", async (ctx) => {
    requireAdmin(ctx.user);
    const body = await ctx.body<{ version?: string }>();
    const version = (body.version ?? "").trim() || snapshot().latest?.version;
    if (!version) return json({ dismissed: false });
    dismissUpdate(version);
    return json({ dismissed: true, version });
  });

  router.post("/api/panel/update/install", async (ctx) => {
    requireAdmin(ctx.user);
    const started = await startInstall({ actor: ctx.user!.username, actorId: ctx.user!.id });
    return json({ job: started.job, targetVersion: started.targetVersion }, { status: 202 });
  });

  router.get("/api/panel/update/job", async (ctx) => {
    return json({ job: latestJob(), history: recentJobs(5), update: snapshot() });
  });

  /* --- Restart -------------------------------------------------------- */
  router.get("/api/panel/restart", async (ctx) => {
    return json({ ...restartSnapshot(), canManage: canManage(ctx.user) });
  });

  router.post("/api/panel/restart", async (ctx) => {
    requireAdmin(ctx.user);
    const body = await ctx.body<{ reason?: string; acknowledge?: boolean }>();
    const update = snapshot();
    const pending = update.pendingRestartVersion;
    if (!body.acknowledge) {
      // A restart interrupts every browser session and any console the operator is watching. Ask.
      throw new ApiException(400, "not_acknowledged", "Confirm the restart first — every open panel session is interrupted for a few seconds.");
    }
    const state = requestPanelRestart({
      kind: pending ? "update" : "manual",
      reason: (body.reason ?? "").trim().slice(0, 200) || (pending ? `Applying RSLMC ${pending}` : "Restart requested from the About page"),
      actor: ctx.user!.username,
      actorId: ctx.user!.id,
      toVersion: pending ?? APP_VERSION,
    });
    return json({
      restart: state,
      message: "RSLMC is restarting. Running servers keep running — the panel is back in a few seconds.",
    }, { status: 202 });
  });

  /* --- Permissions the About page uses to decide what to show ---------- */
  router.get("/api/panel/permissions", async (ctx) => {
    if (!ctx.user) throw forbidden();
    return json({ permissions: permissionsForUser(ctx.user.id, ctx.user.isRoot), canManagePanel: canManage(ctx.user) }, {});
  });
}


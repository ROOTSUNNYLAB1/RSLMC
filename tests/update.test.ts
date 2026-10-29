import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createTarGz } from "../src/shared/archive";

/*
 * End-to-end update flow against a fake GitHub.
 *
 * A local HTTP server plays the role of api.github.com *and* of the release CDN: it serves a release
 * list, a real .tar.gz built by the panel's own archiver, and a SHA256SUMS file. The installer is run
 * against a throwaway copy of an "app folder" (targetRoot), so the test exercises the real code path
 * — manifest, download, checksum, unpack, validate, rollback copy, swap, dependency step — without
 * touching the working tree or the live database.
 */

const DATA_DIR = mkdtempSync(join(tmpdir(), "rslmc-update-"));
const APP_ROOT = mkdtempSync(join(tmpdir(), "rslmc-app-"));
const BUILD_DIR = mkdtempSync(join(tmpdir(), "rslmc-build-"));
process.env.RSLMC_DATA_DIR = DATA_DIR;
process.env.RSLMC_ALLOW_INSECURE_UPDATE_FEED = "1";

const TARGET_VERSION = "2026.11.02";

interface FakeRelease {
  tag: string;
  name: string;
  body: string;
  prerelease?: boolean;
  draft?: boolean;
  assets: Array<{ name: string; path: string; bytes: Buffer }>;
}

let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";
let releases: FakeRelease[] = [];
let requests: string[] = [];
let archiveBytes: Buffer;
let checksumBytes: Buffer;

/** A minimal but *valid* panel tree — what the installer's validation step demands. */
function buildAppTree(root: string, version: string, marker: string): void {
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "frontend"), { recursive: true });
  mkdirSync(join(root, "migrations"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "rslmc", version }, null, 2));
  writeFileSync(join(root, "src", "index.ts"), "// entry point\n");
  writeFileSync(join(root, "src", "marker.ts"), `export const marker = ${JSON.stringify(marker)};\n`);
  writeFileSync(join(root, "frontend", "index.html"), "<!doctype html><title>RSLMC</title>");
  writeFileSync(join(root, "migrations", "001_init.sql"), "-- schema\n");
  writeFileSync(join(root, "scripts", "setup.ts"), "// setup\n");
  writeFileSync(join(root, "README.md"), `# RSLMC ${version}\n`);
}

beforeAll(async () => {
  // The old build that is "installed" in the throwaway app folder.
  buildAppTree(APP_ROOT, "2026.10.29", "old");
  // Data that must survive an update.
  mkdirSync(join(APP_ROOT, "database"), { recursive: true });
  writeFileSync(join(APP_ROOT, "database", "rslmc.db"), "precious-database-bytes");
  writeFileSync(join(APP_ROOT, ".env"), "RSLMC_PORT=3000\n");

  // The new build, packaged like a GitHub release archive (single top-level folder).
  const packaged = join(BUILD_DIR, "rslmc-new");
  buildAppTree(packaged, TARGET_VERSION, "new");
  writeFileSync(join(packaged, "NEW-IN-THIS-RELEASE.txt"), "hello from the future\n");
  const archivePath = join(BUILD_DIR, "rslmc.tar.gz");
  createTarGz(archivePath, { cwd: BUILD_DIR, paths: ["rslmc-new"] });
  archiveBytes = readFileSync(archivePath);
  const digest = createHash("sha256").update(archiveBytes).digest("hex");
  checksumBytes = Buffer.from(`${digest}  rslmc-${TARGET_VERSION}.tar.gz\n`);

  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      requests.push(url.pathname);
      if (url.pathname.startsWith("/missing/")) return new Response("not found", { status: 404 });
      const assetUrl = (name: string) => `http://127.0.0.1:${server.port}/download/${name}`;
      if (url.pathname.endsWith("/releases")) {
        return Response.json(releases.map((release) => ({
          tag_name: release.tag,
          name: release.name,
          body: release.body,
          html_url: `https://github.com/example/RSLMC/releases/tag/${release.tag}`,
          published_at: "2026-11-02T09:00:00Z",
          prerelease: Boolean(release.prerelease),
          draft: Boolean(release.draft),
          assets: release.assets.map((asset) => ({
            name: asset.name,
            browser_download_url: assetUrl(asset.name),
            size: asset.bytes.length,
            content_type: "application/gzip",
          })),
        })));
      }
      if (url.pathname.endsWith("/tags")) return Response.json([]);
      if (url.pathname.startsWith("/download/")) {
        const name = url.pathname.slice("/download/".length);
        if (name.endsWith(".tar.gz")) {
          return new Response(new Uint8Array(archiveBytes), { headers: { "content-length": String(archiveBytes.length) } });
        }
        if (name === "SHA256SUMS") return new Response(new Uint8Array(checksumBytes));
      }
      if (url.pathname === "/repos/example/RSLMC") {
        return Response.json({
          full_name: "example/RSLMC", description: "fake", html_url: "https://github.com/example/RSLMC",
          stargazers_count: 12, forks_count: 3, subscribers_count: 2, open_issues_count: 1,
          license: { spdx_id: "MIT" }, default_branch: "main", topics: ["minecraft"], archived: false,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
  process.env.RSLMC_GITHUB_API = baseUrl;
  process.env.RSLMC_GITHUB_REPO = "example/RSLMC";

  releases = [
    {
      tag: `v${TARGET_VERSION}`, name: `RSLMC ${TARGET_VERSION}`,
      body: "## What's new\n- The panel can now update itself.\n- CalVer releases.",
      assets: [
        { name: `rslmc-${TARGET_VERSION}.tar.gz`, path: "a", bytes: archiveBytes },
        { name: "SHA256SUMS", path: "b", bytes: checksumBytes },
      ],
    },
    {
      tag: "v2026.09.01", name: "RSLMC 2026.09.01", body: "older release",
      assets: [{ name: "rslmc-2026.09.01.tar.gz", path: "c", bytes: Buffer.from("old") }],
    },
    {
      tag: "v2026.12.01-rc", name: "Release candidate", body: "prerelease", prerelease: true,
      assets: [{ name: "rslmc-2026.12.01-rc.tar.gz", path: "d", bytes: Buffer.from("rc") }],
    },
    {
      tag: "v2027.01.01", name: "Draft", body: "never published", draft: true,
      assets: [{ name: "rslmc-2027.01.01.tar.gz", path: "e", bytes: Buffer.from("draft") }],
    },
  ];
});

afterAll(() => {
  server?.stop(true);
  for (const dir of [DATA_DIR, APP_ROOT, BUILD_DIR]) rmSync(dir, { recursive: true, force: true });
});

describe("update discovery", () => {
  test("finds the newest stable release and ignores drafts", async () => {
    const github = await import("../src/update/github");
    const { items, source } = await github.listAvailableVersions({ includePrerelease: false });
    expect(source).toBe("releases");
    expect(items.map((item) => item.version)).toEqual([TARGET_VERSION, "2026.09.01"]);
    expect(items.some((item) => item.version === "2027.01.01")).toBe(false);
  });

  test("prereleases only appear when asked for", async () => {
    const github = await import("../src/update/github");
    const { items } = await github.listAvailableVersions({ includePrerelease: true });
    expect(items.some((item) => item.prerelease)).toBe(true);
  });

  test("picks the versioned tarball and its checksum file", async () => {
    const github = await import("../src/update/github");
    const { items } = await github.listAvailableVersions({});
    const release = items.find((item) => item.version === TARGET_VERSION)!;
    expect(github.installerAsset(release)!.name).toBe(`rslmc-${TARGET_VERSION}.tar.gz`);
    expect(github.checksumAsset(release)!.name).toBe("SHA256SUMS");
  });

  test("repository metadata is readable", async () => {
    const github = await import("../src/update/github");
    const info = await github.fetchRepositoryInfo();
    expect(info.fullName).toBe("example/RSLMC");
    expect(info.stars).toBe(12);
    expect(info.license).toBe("MIT");
  });

  test("a missing repository produces an actionable message", async () => {
    process.env.RSLMC_GITHUB_API = `${baseUrl}/missing`;
    const github = await import("../src/update/github");
    await expect(github.listReleases()).rejects.toThrow(/404|not found/i);
    process.env.RSLMC_GITHUB_API = baseUrl;
  });
});

describe("update state", () => {
  test("records the newest release and reports it as available", async () => {
    const database = await import("../src/database");
    const bootstrap = await import("../src/services/bootstrap");
    const service = await import("../src/update/service");
    database.getDb();
    await bootstrap.bootstrap();

    const result = await service.checkForUpdates({ notifyAdmins: true });
    expect(result.latest?.version).toBe(TARGET_VERSION);
    expect(result.updateAvailable).toBe(true);
    expect(result.currentVersion).toBe("2026.10.29");
    expect(result.latest?.verified).toBe(true);
    expect(result.lastCheckError).toBeNull();
    expect(result.latest?.releaseAge).toBeTruthy();

    // The admin got exactly one notification for this version, and the second check does not repeat it.
    const notifications = database.query<{ id: number }>(
      "SELECT id FROM notifications WHERE kind = 'panel_update' AND title LIKE '%available%'",
    );
    expect(notifications.length).toBe(1);
    await service.checkForUpdates({ notifyAdmins: true });
    expect(database.query("SELECT id FROM notifications WHERE kind = 'panel_update' AND title LIKE '%available%'").length).toBe(1);
  });

  test("settings are validated and persisted", async () => {
    const service = await import("../src/update/service");
    const saved = service.saveSettings({ intervalMinutes: 5 });
    // Below the floor: clamped, not silently accepted.
    expect(saved.intervalMinutes).toBe(30);
    expect(service.saveSettings({ autoCheck: false }).autoCheck).toBe(false);
    expect(service.saveSettings({ autoCheck: true, includePrerelease: true }).includePrerelease).toBe(true);
    expect(service.saveSettings({ includePrerelease: false }).includePrerelease).toBe(false);
  });

  test("a check failure is reported, not swallowed", async () => {
    const service = await import("../src/update/service");
    process.env.RSLMC_GITHUB_API = "http://127.0.0.1:1";
    const failed = await service.checkForUpdates({ notifyAdmins: false });
    expect(failed.lastCheckError).toBeTruthy();
    // The previously known release is kept: a network blip must not make the banner disappear.
    expect(failed.latest?.version).toBe(TARGET_VERSION);
    process.env.RSLMC_GITHUB_API = baseUrl;
  });
});

describe("installation", () => {
  test("installs the release into the target folder and keeps the data", async () => {
    const installer = await import("../src/update/installer");
    const started = await installer.startInstall({ actor: "admin", actorId: 1, targetRoot: APP_ROOT });
    expect(started.targetVersion).toBe(TARGET_VERSION);

    const deadline = Date.now() + 60_000;
    let job = installer.latestJob();
    while (Date.now() < deadline && job && job.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 150));
      job = installer.latestJob();
    }

    expect(job!.status).toBe("success");
    expect(job!.error).toBeNull();
    const statuses = Object.fromEntries(job!.steps.map((entry) => [entry.id, entry.status]));
    expect(statuses.manifest).toBe("done");
    expect(statuses.disk).toBe("done");
    expect(statuses.download).toBe("done");
    expect(statuses.checksum).toBe("done");
    expect(statuses.extract).toBe("done");
    expect(statuses.validate).toBe("done");
    expect(statuses.backup).toBe("done");
    expect(statuses.apply).toBe("done");
    expect(statuses.finish).toBe("done");

    // New files are in place…
    expect(readFileSync(join(APP_ROOT, "src", "marker.ts"), "utf8")).toContain("new");
    expect(readFileSync(join(APP_ROOT, "package.json"), "utf8")).toContain(TARGET_VERSION);
    expect(existsSync(join(APP_ROOT, "NEW-IN-THIS-RELEASE.txt"))).toBe(true);
    // …and data is not.
    expect(readFileSync(join(APP_ROOT, "database", "rslmc.db"), "utf8")).toBe("precious-database-bytes");
    expect(readFileSync(join(APP_ROOT, ".env"), "utf8")).toContain("RSLMC_PORT=3000");

    // The rollback copy exists and is a real archive.
    const backupsDir = join(DATA_DIR, "backups", "panel");
    const backups = [...new Bun.Glob("code-*.tar.gz").scanSync(backupsDir)];
    expect(backups.length).toBe(1);
  }, 90_000);

  test("the installed version is recorded as pending a restart", async () => {
    const service = await import("../src/update/service");
    expect(service.pendingRestartVersion()).toBe(TARGET_VERSION);
    expect(service.installedAt()).toBeTruthy();
    const snap = service.snapshot();
    // The candidate was cleared: there is nothing left to install, only a restart to do.
    expect(snap.latest).toBeNull();
    expect(snap.pendingRestartVersion).toBe(TARGET_VERSION);
  });

  test("refuses to install when nothing newer is known", async () => {
    const installer = await import("../src/update/installer");
    await expect(installer.startInstall({ actor: "admin", actorId: 1, targetRoot: APP_ROOT }))
      .rejects.toThrow(/newest release|No release/i);
  });

  test("a corrupted archive is rejected before a single file is swapped", async () => {
    const service = await import("../src/update/service");
    const installer = await import("../src/update/installer");
    // Make the checksum file disagree with the archive bytes.
    checksumBytes = Buffer.from(`${"0".repeat(64)}  rslmc-2026.12.05.tar.gz\n`);
    const brokenArchive = archiveBytes;
    releases.unshift({
      tag: "v2026.12.05", name: "RSLMC 2026.12.05", body: "corrupt on purpose",
      assets: [
        { name: "rslmc-2026.12.05.tar.gz", path: "x", bytes: brokenArchive },
        { name: "SHA256SUMS", path: "y", bytes: checksumBytes },
      ],
    });
    await service.checkForUpdates({ notifyAdmins: false });

    const marker = readFileSync(join(APP_ROOT, "src", "marker.ts"), "utf8");
    await installer.startInstall({ actor: "admin", actorId: 1, targetRoot: APP_ROOT });
    const deadline = Date.now() + 30_000;
    let job = installer.latestJob();
    while (Date.now() < deadline && job && job.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 120));
      job = installer.latestJob();
    }
    expect(job!.status).toBe("failed");
    expect(job!.steps.find((entry) => entry.id === "checksum")!.status).toBe("failed");
    expect(job!.steps.find((entry) => entry.id === "apply")!.status).toBe("pending");
    // Nothing on disk changed.
    expect(readFileSync(join(APP_ROOT, "src", "marker.ts"), "utf8")).toBe(marker);
  }, 60_000);

  test("concurrent installs are refused", async () => {
    const installer = await import("../src/update/installer");
    const service = await import("../src/update/service");
    (service as any).setInstalling(true);
    await expect(installer.startInstall({ actor: "admin", actorId: 1, targetRoot: APP_ROOT }))
      .rejects.toThrow(/already being installed/i);
    (service as any).setInstalling(false);
  });

  test("job history is queryable for the About page", async () => {
    const installer = await import("../src/update/installer");
    const history = installer.recentJobs(5);
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0]!.steps.length).toBe(10);
  });
});

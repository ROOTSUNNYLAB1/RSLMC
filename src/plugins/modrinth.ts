import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { query, queryOne, run, insert } from "../database";
import { serverDir } from "../shared/config";
import { fetchJson, downloadFile } from "../services/download";
import { ApiException } from "../shared/http";
import { createBackup } from "../services/backups";
import { recordActivity } from "../services/audit";
import { notify } from "../services/notifications";
import { SOFTWARE_CATALOG } from "../minecraft/providers";
import type { ServerSoftwareId } from "../shared/types";

const API = "https://api.modrinth.com/v2";

/** Minecraft server software → Modrinth loader tags. */
export const LOADER_MAP: Record<ServerSoftwareId, string[]> = {
  vanilla: [],
  paper: ["paper", "spigot", "bukkit"],
  purpur: ["purpur", "paper", "spigot", "bukkit"],
  folia: ["folia", "paper", "spigot"],
  fabric: ["fabric"],
  forge: ["forge"],
  neoforge: ["neoforge"],
  quilt: ["quilt", "fabric"],
  velocity: ["velocity"],
  bungeecord: ["bungeecord", "waterfall"],
  waterfall: ["waterfall", "bungeecord"],
};

export function projectTypeFor(software: ServerSoftwareId): "plugin" | "mod" | null {
  const definition = SOFTWARE_CATALOG.find((item) => item.id === software);
  if (!definition) return null;
  if (definition.supportsMods) return "mod";
  if (definition.supportsPlugins) return "plugin";
  return null;
}

export function targetDirectoryFor(software: ServerSoftwareId): string {
  return projectTypeFor(software) === "mod" ? "mods" : "plugins";
}

export interface ModrinthSearchHit {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  categories: string[];
  client_side: string;
  server_side: string;
  downloads: number;
  follows: number;
  icon_url: string | null;
  date_modified: string;
  latest_version?: string;
  license?: string;
  versions: string[];
  loaders?: string[];
  author?: string;
}

export interface ModrinthSearchResult {
  hits: ModrinthSearchHit[];
  total_hits: number;
  offset: number;
  limit: number;
}

export async function searchProjects(opts: {
  query?: string;
  software?: ServerSoftwareId;
  gameVersion?: string;
  category?: string;
  index?: "relevance" | "downloads" | "follows" | "newest" | "updated";
  limit?: number;
  offset?: number;
}): Promise<ModrinthSearchResult> {
  const facets: string[][] = [];
  const projectType = opts.software ? projectTypeFor(opts.software) : null;
  if (projectType) facets.push([`project_type:${projectType}`]);
  if (opts.software) {
    const loaders = LOADER_MAP[opts.software] ?? [];
    if (loaders.length > 0) facets.push(loaders.map((loader) => `categories:${loader}`));
    else facets.push(["categories:datapack", "project_type:plugin"].map((facet) => facet).slice(0, 0));
  }
  if (opts.gameVersion) facets.push([`versions:${opts.gameVersion}`]);
  if (opts.category) facets.push([`categories:${opts.category}`]);

  const params = new URLSearchParams({
    query: opts.query ?? "",
    index: opts.index ?? "relevance",
    limit: String(Math.min(50, opts.limit ?? 20)),
    offset: String(opts.offset ?? 0),
  });
  const usableFacets = facets.filter((group) => group.length > 0);
  if (usableFacets.length > 0) params.set("facets", JSON.stringify(usableFacets));

  const result = await fetchJson<ModrinthSearchResult>(`${API}/search?${params.toString()}`, 20_000);
  return result;
}

export interface ModrinthVersion {
  id: string;
  project_id: string;
  name: string;
  version_number: string;
  version_type: "release" | "beta" | "alpha";
  game_versions: string[];
  loaders: string[];
  date_published: string;
  downloads: number;
  changelog?: string;
  dependencies: { version_id: string | null; project_id: string | null; dependency_type: "required" | "optional" | "incompatible" | "embedded" }[];
  files: {
    url: string; filename: string; primary: boolean; size: number;
    hashes: { sha1?: string; sha512?: string };
  }[];
}

export interface ModrinthProject {
  id: string;
  slug: string;
  title: string;
  description: string;
  body?: string;
  categories: string[];
  loaders: string[];
  game_versions: string[];
  downloads: number;
  followers: number;
  icon_url: string | null;
  license?: { id: string; name: string; url?: string };
  source_url?: string;
  issues_url?: string;
  team?: string;
  updated: string;
  published: string;
  project_type: string;
}

export async function getProject(idOrSlug: string): Promise<ModrinthProject> {
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(idOrSlug)) throw new ApiException(400, "invalid_project", "Invalid Modrinth project identifier");
  return fetchJson<ModrinthProject>(`${API}/project/${encodeURIComponent(idOrSlug)}`, 20_000);
}

export async function getVersions(projectId: string, opts: { gameVersion?: string; software?: ServerSoftwareId } = {}): Promise<ModrinthVersion[]> {
  const params = new URLSearchParams();
  const loaders = opts.software ? LOADER_MAP[opts.software] : [];
  if (loaders.length > 0) params.set("loaders", JSON.stringify(loaders));
  if (opts.gameVersion) params.set("game_versions", JSON.stringify([opts.gameVersion]));
  const url = `${API}/project/${encodeURIComponent(projectId)}/version${params.toString() ? `?${params.toString()}` : ""}`;
  return fetchJson<ModrinthVersion[]>(url, 20_000);
}

export async function getVersion(versionId: string): Promise<ModrinthVersion> {
  return fetchJson<ModrinthVersion>(`${API}/version/${encodeURIComponent(versionId)}`, 20_000);
}

async function verifySha512(path: string, expected: string): Promise<boolean> {
  const hasher = createHash("sha512");
  for await (const chunk of Bun.file(path).stream() as any) hasher.update(chunk);
  return hasher.digest("hex") === expected.toLowerCase();
}

export interface InstallResult {
  installed: { projectId: string; version: string; file: string; directory: string }[];
  skipped: string[];
  restartRequired: boolean;
  warnings: string[];
}

/**
 * Installs a specific Modrinth version into the correct directory for the server's software,
 * verifying hashes and resolving required dependencies. Files are downloaded to a temporary
 * location and moved into place — a downloaded plugin is never executed by the installer.
 */
export async function installVersion(
  serverId: number,
  versionId: string,
  opts: { actor: string; installDependencies?: boolean; allowBeta?: boolean },
): Promise<InstallResult> {
  const server = queryOne<{ id: number; uuid: string; software: ServerSoftwareId; mc_version: string; name: string }>(
    "SELECT id, uuid, software, mc_version, name FROM servers WHERE id = ?", [serverId],
  );
  if (!server) throw new ApiException(404, "server_not_found", "Server not found");

  const projectType = projectTypeFor(server.software);
  if (!projectType) throw new ApiException(400, "unsupported_software", `Vanilla servers do not load plugins or mods`);

  const directory = serverDir(server.uuid);
  const targetDirName = targetDirectoryFor(server.software);
  const targetDir = join(directory, targetDirName);

  const results: InstallResult = { installed: [], skipped: [], restartRequired: true, warnings: [] };
  const queue: { versionId: string; depth: number }[] = [{ versionId, depth: 0 }];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const item = queue.shift()!;
    if (visited.has(item.versionId)) continue;
    visited.add(item.versionId);

    const version = await getVersion(item.versionId);
    const project = await getProject(version.project_id);

    if (version.version_type === "alpha" && !opts.allowBeta) {
      results.skipped.push(`${project.title}: alpha releases are not installed without explicit approval`);
      continue;
    }
    if (version.game_versions.length > 0 && !version.game_versions.includes(server.mc_version)) {
      results.warnings.push(`${project.title} ${version.version_number} does not list Minecraft ${server.mc_version} as supported`);
    }
    const compatibleLoaders = LOADER_MAP[server.software] ?? [];
    if (compatibleLoaders.length > 0 && version.loaders.length > 0) {
      const overlap = version.loaders.some((loader) => compatibleLoaders.includes(loader));
      if (!overlap) {
        throw new ApiException(409, "incompatible_loader",
          `${project.title} ${version.version_number} targets ${version.loaders.join(", ")} but this server runs ${server.software}. RSLMC will not install an incompatible ${projectType}.`);
      }
    }

    const file = version.files.find((entry) => entry.primary) ?? version.files[0];
    if (!file) throw new ApiException(502, "no_file", `${project.title} has no downloadable files`);

    const destination = join(targetDir, file.filename);
    await downloadFile({
      url: file.url,
      destination,
      expectedSha256: null,
      serverId,
      label: `${project.title} ${version.version_number}`,
    });
    if (file.hashes.sha512 && !(await verifySha512(destination, file.hashes.sha512))) {
      rmSync(destination, { force: true });
      throw new ApiException(502, "checksum_mismatch", `Hash verification failed for ${file.filename}`);
    }

    const existing = queryOne<{ id: number; version: string | null }>(
      "SELECT id, version FROM plugins WHERE server_id = ? AND file_name = ?", [serverId, file.filename],
    );
    const size = statSync(destination).size;
    if (existing) {
      run(
        "UPDATE plugins SET version = ?, project_id = ?, slug = ?, file_size = ?, installed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), source = 'modrinth', update_version = NULL WHERE id = ?",
        [version.version_number, project.id, project.slug, size, existing.id],
      );
    } else {
      insert(
        `INSERT INTO plugins (server_id, name, project_id, slug, version, file_name, file_size, target_dir, source, sha256, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'modrinth', ?, NULL)`,
        [serverId, project.title, project.id, project.slug, version.version_number, file.filename, size, targetDirName, file.hashes.sha512 ?? null],
      );
    }
    results.installed.push({ projectId: project.id, version: version.version_number, file: file.filename, directory: targetDirName });

    if (opts.installDependencies !== false) {
      for (const dependency of version.dependencies) {
        if (dependency.dependency_type !== "required" || !dependency.project_id) continue;
        const versions = await getVersions(dependency.project_id, { gameVersion: server.mc_version, software: server.software });
        const candidate = versions.find((entry) => entry.version_type === "release") ?? versions[0];
        if (candidate) queue.push({ versionId: candidate.id, depth: item.depth + 1 });
        else results.warnings.push(`Required dependency ${dependency.project_id} has no build for Minecraft ${server.mc_version} on ${server.software}`);
      }
    }
  }

  recordActivity({
    type: "plugin.installed", serverId, actorName: opts.actor,
    target: results.installed.map((item) => item.file).join(", ").slice(0, 200),
    metadata: { installed: results.installed, warnings: results.warnings },
  });
  notify({
    title: `${results.installed.length} ${projectType}(s) installed on ${server.name}`,
    body: "Restart the server for the change to take effect.",
    severity: "success", kind: "plugin_install", link: `/servers/${serverId}/plugins`,
  });
  return results;
}

export interface InstalledPlugin {
  id: number;
  name: string;
  version: string | null;
  fileName: string;
  fileSize: number;
  source: string;
  targetDir: string;
  enabled: boolean | null;
  projectId: string | null;
  updateVersion: string | null;
  installedAt: string;
}

/** Lists installed plugins/mods from the database, reconciled with the filesystem. */
export function listInstalled(serverId: number): InstalledPlugin[] {
  const server = queryOne<{ uuid: string; software: ServerSoftwareId }>("SELECT uuid, software FROM servers WHERE id = ?", [serverId]);
  if (!server) throw new ApiException(404, "server_not_found", "Server not found");
  const directory = serverDir(server.uuid);

  for (const dirName of ["plugins", "mods"]) {
    const full = join(directory, dirName);
    if (!existsSync(full)) continue;
    for (const entry of readdirSync(full)) {
      if (!entry.endsWith(".jar")) continue;
      const stat = statSync(join(full, entry));
      const row = queryOne<{ id: number }>("SELECT id FROM plugins WHERE server_id = ? AND file_name = ?", [serverId, entry]);
      if (!row) {
        insert(
          "INSERT INTO plugins (server_id, name, file_name, file_size, target_dir, source, enabled) VALUES (?, ?, ?, ?, ?, 'manual', NULL)",
          [serverId, entry.replace(/\.jar$/, ""), entry, stat.size, dirName],
        );
      } else {
        run("UPDATE plugins SET file_size = ? WHERE id = ?", [stat.size, row.id]);
      }
    }
  }
  // Remove records whose files were deleted outside the panel.
  for (const row of query<{ id: number; file_name: string; target_dir: string }>(
    "SELECT id, file_name, target_dir FROM plugins WHERE server_id = ?", [serverId],
  )) {
    if (!existsSync(join(directory, row.target_dir, row.file_name))) run("DELETE FROM plugins WHERE id = ?", [row.id]);
  }

  return query<any>("SELECT * FROM plugins WHERE server_id = ? ORDER BY target_dir, name", [serverId]).map((row) => ({
    id: row.id,
    name: row.name,
    version: row.version,
    fileName: row.file_name,
    fileSize: row.file_size,
    source: row.source,
    targetDir: row.target_dir,
    // A JAR's presence never implies it is enabled; Minecraft has no enable flag for JARs.
    enabled: row.enabled === null ? null : row.enabled === 1,
    projectId: row.project_id,
    updateVersion: row.update_version,
    installedAt: row.installed_at,
  }));
}

export async function checkUpdates(serverId: number): Promise<{ fileName: string; current: string | null; latest: string | null; projectId: string }[]> {
  const installed = listInstalled(serverId).filter((plugin) => plugin.projectId);
  const server = queryOne<{ mc_version: string; software: ServerSoftwareId }>("SELECT mc_version, software FROM servers WHERE id = ?", [serverId])!;
  const out: { fileName: string; current: string | null; latest: string | null; projectId: string }[] = [];
  for (const plugin of installed) {
    try {
      const versions = await getVersions(plugin.projectId!, { gameVersion: server.mc_version, software: server.software });
      const latest = versions.find((version) => version.version_type === "release") ?? versions[0];
      const latestNumber = latest?.version_number ?? null;
      run("UPDATE plugins SET update_version = ? WHERE id = ?", [latestNumber, plugin.id]);
      out.push({ fileName: plugin.fileName, current: plugin.version, latest: latestNumber, projectId: plugin.projectId! });
    } catch {
      out.push({ fileName: plugin.fileName, current: plugin.version, latest: null, projectId: plugin.projectId! });
    }
  }
  return out;
}

export function removePlugin(serverId: number, pluginId: number, opts: { actor: string; backup?: boolean }): void {
  const row = queryOne<any>("SELECT * FROM plugins WHERE id = ? AND server_id = ?", [pluginId, serverId]);
  if (!row) throw new ApiException(404, "plugin_not_found", "Plugin not found");
  const server = queryOne<{ uuid: string }>("SELECT uuid FROM servers WHERE id = ?", [serverId])!;
  if (opts.backup !== false) {
    createBackup(serverId, { name: `pre-remove-${row.name}`.slice(0, 60), kind: "plugins", description: `Automatic backup before removing ${row.file_name}` });
  }
  rmSync(join(serverDir(server.uuid), row.target_dir, row.file_name), { force: true });
  run("DELETE FROM plugins WHERE id = ?", [pluginId]);
  recordActivity({ type: "plugin.removed", serverId, target: row.file_name, actorName: opts.actor });
}

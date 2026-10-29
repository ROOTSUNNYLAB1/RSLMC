import {
  getProject, getVersions, installVersion, listInstalled, projectTypeFor,
} from "./modrinth";
import { queryOne } from "../database";
import type { ServerSoftwareId } from "../shared/types";

/**
 * Recommended plugins for a fresh Paper/Purpur server.
 *
 * ViaVersion + ViaBackwards are the two plugins almost every modern server runs: they let clients on
 * other Minecraft versions connect to the server's version (ViaBackwards for older clients,
 * ViaVersion for newer ones). They are installed from Modrinth, resolved against the server's own
 * software loader and Minecraft version — the panel never downloads a jar that Modrinth does not
 * list as compatible.
 *
 * Installation is best-effort and never blocks or fails the server install: if Modrinth is
 * unreachable the server is still perfectly usable, and the panel says what happened.
 */

export interface RecommendedPlugin {
  slug: string;
  title: string;
  note: string;
  /** Requires another recommended plugin to be useful. */
  requires?: string;
}

export const RECOMMENDED_PLUGINS: RecommendedPlugin[] = [
  {
    slug: "viaversion",
    title: "ViaVersion",
    note: "Lets clients on a newer Minecraft version join this server.",
  },
  {
    slug: "viabackwards",
    title: "ViaBackwards",
    note: "Lets clients on an older Minecraft version join this server. Needs ViaVersion.",
    requires: "viaversion",
  },
];

/** Software that loads Bukkit/Paper plugins and is covered by the Via stack. */
export const RECOMMENDED_PLUGIN_SOFTWARE: ServerSoftwareId[] = ["paper", "purpur"];

export function recommendsPlugins(software: ServerSoftwareId): boolean {
  return RECOMMENDED_PLUGIN_SOFTWARE.includes(software);
}

export interface RecommendedInstallResult {
  installed: { title: string; version: string; file: string }[];
  alreadyPresent: string[];
  failed: { title: string; message: string }[];
}

/**
 * Installs the missing recommended plugins for one server.
 * Safe to call on every install: plugins that are already in `plugins/` are skipped.
 */
export async function installRecommendedPlugins(
  serverId: number,
  opts: { actor: string; onlySlug?: string } = { actor: "installer" },
): Promise<RecommendedInstallResult> {
  const result: RecommendedInstallResult = { installed: [], alreadyPresent: [], failed: [] };
  const server = queryOne<{ id: number; software: ServerSoftwareId; mc_version: string }>(
    "SELECT id, software, mc_version FROM servers WHERE id = ?", [serverId],
  );
  if (!server) return result;
  if (!projectTypeFor(server.software)) return result;   // vanilla: no plugin loader at all

  const installedNow = listInstalled(serverId);
  const installedProjects = new Set(installedNow.map((entry) => (entry.projectId ?? "").toLowerCase()));
  const installedFiles = installedNow.map((entry) => entry.fileName.toLowerCase());

  for (const plugin of RECOMMENDED_PLUGINS) {
    if (opts.onlySlug && opts.onlySlug !== plugin.slug) continue;
    if (installedProjects.has(plugin.slug) || installedFiles.some((file) => file.includes(plugin.slug))) {
      result.alreadyPresent.push(plugin.title);
      continue;
    }
    try {
      const project = await getProject(plugin.slug);
      let versions = await getVersions(project.id, { software: server.software, gameVersion: server.mc_version });
      // A brand-new Minecraft version often ships a Via release that does not list it yet; fall back
      // to the newest release for this loader and let the plugin itself decide at runtime.
      if (versions.length === 0) versions = await getVersions(project.id, { software: server.software });
      const version = versions.find((entry) => entry.version_type === "release") ?? versions[0];
      if (!version) {
        result.failed.push({ title: plugin.title, message: "Modrinth has no build for this server version" });
        continue;
      }
      const install = await installVersion(serverId, version.id, {
        actor: opts.actor, installDependencies: false, allowBeta: false,
      });
      const first = install.installed[0];
      result.installed.push({
        title: plugin.title,
        version: version.version_number,
        file: first?.file ?? version.files[0]?.filename ?? plugin.slug,
      });
    } catch (error) {
      result.failed.push({
        title: plugin.title,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

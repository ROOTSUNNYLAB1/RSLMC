import { existsSync, readdirSync, statSync } from "node:fs";
import { ensureDir, movePath } from "../shared/platform";
import { join } from "node:path";
import { fetchJson, downloadFile, writeFileAtomic } from "../services/download";
import { ApiException } from "../shared/http";
import type { ServerSoftwareId, SoftwareDefinition } from "../shared/types";
import { javaMajorForMcVersion } from "./java-requirements";

export const SOFTWARE_CATALOG: SoftwareDefinition[] = [
  {
    id: "vanilla", name: "Vanilla", kind: "vanilla", proxy: false, installerBased: false,
    supportsPlugins: false, supportsMods: false, supported: true,
    description: "Official Mojang server software. No plugins or mods, exactly as shipped by Mojang.",
    source: "piston-meta.mojang.com", docsUrl: "https://www.minecraft.net/download/server",
  },
  {
    id: "paper", name: "Paper", kind: "plugin", proxy: false, installerBased: false,
    supportsPlugins: true, supportsMods: false, supported: true,
    description: "High-performance Spigot fork with a large plugin ecosystem and extensive configuration.",
    source: "fill.papermc.io", docsUrl: "https://docs.papermc.io/",
  },
  {
    id: "purpur", name: "Purpur", kind: "plugin", proxy: false, installerBased: false,
    supportsPlugins: true, supportsMods: false, supported: true,
    description: "Paper fork adding gameplay and configuration features. Accepts Paper plugins.",
    source: "api.purpurmc.org", docsUrl: "https://purpurmc.org/docs/",
  },
  {
    id: "folia", name: "Folia", kind: "plugin", proxy: false, installerBased: false,
    supportsPlugins: true, supportsMods: false, supported: true,
    description: "Paper's regionised multithreaded server. Requires Folia-aware plugins.",
    source: "fill.papermc.io", docsUrl: "https://docs.papermc.io/folia/",
  },
  {
    id: "fabric", name: "Fabric", kind: "mod", proxy: false, installerBased: true,
    supportsPlugins: false, supportsMods: true, supported: true,
    description: "Lightweight mod loader. Server is prepared with the official Fabric installer.",
    source: "meta.fabricmc.net", docsUrl: "https://fabricmc.net/use/server/",
  },
  {
    id: "forge", name: "Forge", kind: "mod", proxy: false, installerBased: true,
    supportsPlugins: false, supportsMods: true, supported: true,
    description: "Long-standing modding platform. Server is prepared with the official Forge installer.",
    source: "maven.minecraftforge.net", docsUrl: "https://docs.minecraftforge.net/",
  },
  {
    id: "neoforge", name: "NeoForge", kind: "mod", proxy: false, installerBased: true,
    supportsPlugins: false, supportsMods: true, supported: true,
    description: "Community fork of Forge for modern Minecraft versions.",
    source: "maven.neoforged.net", docsUrl: "https://docs.neoforged.net/",
  },
  {
    id: "quilt", name: "Quilt", kind: "mod", proxy: false, installerBased: true,
    supportsPlugins: false, supportsMods: true, supported: true,
    description: "Fabric-derived loader. Installer support is experimental — verify mod compatibility.",
    source: "maven.quiltmc.org", docsUrl: "https://quiltmc.org/",
  },
  {
    id: "velocity", name: "Velocity", kind: "proxy", proxy: true, installerBased: false,
    supportsPlugins: true, supportsMods: false, supported: true,
    description: "Modern Minecraft proxy from PaperMC. Front-end for multiple backend servers.",
    source: "fill.papermc.io", docsUrl: "https://docs.papermc.io/velocity/",
  },
  {
    id: "bungeecord", name: "BungeeCord", kind: "proxy", proxy: true, installerBased: false,
    supportsPlugins: true, supportsMods: false, supported: true,
    description: "Classic proxy maintained by SpigotMC. Builds come from the project CI.",
    source: "ci.md-5.net", docsUrl: "https://www.spigotmc.org/wiki/bungeecord/",
  },
  {
    id: "waterfall", name: "Waterfall", kind: "proxy", proxy: true, installerBased: false,
    supportsPlugins: true, supportsMods: false, supported: true,
    description: "Legacy BungeeCord fork from PaperMC. Waterfall is end-of-life upstream.",
    source: "fill.papermc.io", docsUrl: "https://docs.papermc.io/waterfall/",
  },
];

export function softwareDefinition(id: ServerSoftwareId): SoftwareDefinition {
  const found = SOFTWARE_CATALOG.find((item) => item.id === id);
  if (!found) throw new ApiException(400, "unknown_software", `Unknown server software: ${id}`);
  return found;
}

/* ---------------------------------------------------------------- */
/* Cached upstream metadata                                          */
/* ---------------------------------------------------------------- */

interface CacheEntry { at: number; value: unknown }
const cache = new Map<string, CacheEntry>();
const TTL = 5 * 60 * 1000;

async function cached<T>(key: string, loader: () => Promise<T>, ttl = TTL): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value as T;
  const value = await loader();
  cache.set(key, { at: Date.now(), value });
  return value;
}

export interface VersionInfo {
  id: string;
  type: "release" | "snapshot" | "beta" | "alpha";
  javaMajor: number;
}

export interface BuildInfo {
  version: string;
  build: string | null;
  url: string;
  fileName: string;
  sha256: string | null;
  sha1: string | null;
  size: number | null;
  channel: string;
  javaMinimum: number | null;
  recommendedFlags: string[] | null;
  source: string;
}

/* ---------------------------------------------------------------- */
/* Vanilla (Mojang)                                                  */
/* ---------------------------------------------------------------- */

interface MojangManifest {
  latest: { release: string; snapshot: string };
  versions: { id: string; type: string; url: string; releaseTime: string }[];
}

interface MojangVersionJson {
  id: string;
  javaVersion?: { majorVersion: number };
  downloads?: { server?: { url: string; sha1: string; size: number } };
}

export async function vanillaVersions(includeSnapshots = false): Promise<VersionInfo[]> {
  const manifest = await cached("mojang:manifest", () =>
    fetchJson<MojangManifest>("https://launchermeta.mojang.com/mc/game/version_manifest_v2.json"),
  );
  return manifest.versions
    .filter((v) => includeSnapshots || v.type === "release")
    .slice(0, includeSnapshots ? 120 : 80)
    .map((v) => ({ id: v.id, type: v.type as VersionInfo["type"], javaMajor: javaMajorForMcVersion(v.id) }));
}

async function vanillaBuild(version: string): Promise<BuildInfo> {
  const manifest = await cached("mojang:manifest", () =>
    fetchJson<MojangManifest>("https://launchermeta.mojang.com/mc/game/version_manifest_v2.json"),
  );
  const entry = manifest.versions.find((v) => v.id === version);
  if (!entry) throw new ApiException(404, "version_not_found", `Minecraft ${version} is not in the Mojang manifest`);
  const meta = await cached(`mojang:version:${version}`, () => fetchJson<MojangVersionJson>(entry.url));
  const server = meta.downloads?.server;
  if (!server) throw new ApiException(404, "no_server_download", `Minecraft ${version} has no dedicated server download`);
  return {
    version,
    build: null,
    url: server.url,
    fileName: `vanilla-${version}.jar`,
    sha256: null,
    sha1: server.sha1,
    size: server.size ?? null,
    channel: entry.type,
    javaMinimum: meta.javaVersion?.majorVersion ?? javaMajorForMcVersion(version),
    recommendedFlags: null,
    source: "Mojang piston-meta",
  };
}

/* ---------------------------------------------------------------- */
/* PaperMC family (Paper, Folia, Velocity, Waterfall)                */
/* ---------------------------------------------------------------- */

interface PaperVersionsResponse { versions: Record<string, string[]> }
interface PaperBuild {
  id: number;
  time: string;
  channel: string;
  downloads: Record<string, { name: string; checksums?: { sha256?: string }; size: number; url: string }>;
}
interface PaperVersionDetail {
  version: { id: string; support: { status: string }; java?: { version?: { minimum?: number }; flags?: { recommended?: string[] } } };
}

const PAPER_PROJECTS: Record<string, string> = { paper: "paper", folia: "folia", velocity: "velocity", waterfall: "waterfall" };

export async function paperFamilyVersions(project: string, includeExperimental = false): Promise<VersionInfo[]> {
  const data = await cached(`paper:${project}:versions`, () =>
    fetchJson<PaperVersionsResponse>(`https://fill.papermc.io/v3/projects/${project}`),
  );
  const out: VersionInfo[] = [];
  for (const [group, versions] of Object.entries(data.versions ?? {})) {
    for (const version of versions) {
      const isStable = !/-(rc|pre|snapshot)/i.test(version);
      if (!isStable && !includeExperimental) continue;
      out.push({ id: version, type: isStable ? "release" : "snapshot", javaMajor: javaMajorForMcVersion(version) });
    }
  }
  return out.slice(0, 120);
}

async function paperFamilyLatestBuild(project: string, version: string): Promise<BuildInfo> {
  const detail = await cached(`paper:${project}:${version}:detail`, () =>
    fetchJson<PaperVersionDetail>(`https://fill.papermc.io/v3/projects/${project}/versions/${encodeURIComponent(version)}`),
  );
  const builds = await cached(`paper:${project}:${version}:builds`, () =>
    fetchJson<PaperBuild[]>(`https://fill.papermc.io/v3/projects/${project}/versions/${encodeURIComponent(version)}/builds`),
  );
  const stable = builds.find((b) => b.channel === "STABLE") ?? builds[0];
  if (!stable) throw new ApiException(404, "no_builds", `No builds published for ${project} ${version}`);
  const download = stable.downloads["server:default"] ?? Object.values(stable.downloads)[0];
  if (!download) throw new ApiException(404, "no_download", `Build ${stable.id} of ${project} ${version} has no download`);
  return {
    version,
    build: String(stable.id),
    url: download.url,
    fileName: download.name,
    sha256: download.checksums?.sha256 ?? null,
    sha1: null,
    size: download.size,
    channel: stable.channel,
    javaMinimum: detail.version.java?.version?.minimum ?? javaMajorForMcVersion(version),
    recommendedFlags: detail.version.java?.flags?.recommended ?? null,
    source: `PaperMC fill v3 (${project})`,
  };
}

/* ---------------------------------------------------------------- */
/* Purpur                                                            */
/* ---------------------------------------------------------------- */

export async function purpurVersions(): Promise<VersionInfo[]> {
  const data = await cached("purpur:versions", () => fetchJson<{ versions: string[] }>("https://api.purpurmc.org/v2/purpur"));
  return (data.versions ?? []).slice().reverse().map((id) => ({
    id, type: "release" as const, javaMajor: javaMajorForMcVersion(id),
  }));
}

async function purpurBuild(version: string): Promise<BuildInfo> {
  const data = await cached(`purpur:${version}`, () =>
    fetchJson<{ builds: { latest: string; all: string[] } }>(`https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}`),
  );
  const build = data.builds?.latest;
  if (!build) throw new ApiException(404, "no_builds", `Purpur has no builds for ${version}`);
  const detail = await cached(`purpur:${version}:${build}`, () =>
    fetchJson<{ md5?: string }>(`https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}/${build}`),
  );
  return {
    version,
    build,
    url: `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}/${build}/download`,
    fileName: `purpur-${version}-${build}.jar`,
    sha256: null,
    sha1: null,
    size: null,
    channel: "stable",
    javaMinimum: javaMajorForMcVersion(version),
    recommendedFlags: null,
    source: "Purpur API (MD5 only upstream)",
  };
}

/* ---------------------------------------------------------------- */
/* Mod loaders                                                       */
/* ---------------------------------------------------------------- */

export async function fabricVersions(): Promise<VersionInfo[]> {
  const data = await cached("fabric:game", () => fetchJson<{ version: string; stable: boolean }[]>("https://meta.fabricmc.net/v2/versions/game"));
  return data.filter((item) => item.stable).map((item) => ({
    id: item.version, type: "release" as const, javaMajor: javaMajorForMcVersion(item.version),
  }));
}

export async function forgeVersions(): Promise<VersionInfo[]> {
  const data = await cached("forge:meta", () =>
    fetchJson<Record<string, string[]>>("https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json"),
  );
  const out: VersionInfo[] = [];
  for (const [mc, builds] of Object.entries(data)) {
    if (!Array.isArray(builds) || builds.length === 0) continue;
    out.push({ id: mc, type: "release", javaMajor: javaMajorForMcVersion(mc) });
  }
  return out.reverse();
}

export async function neoforgeVersions(): Promise<VersionInfo[]> {
  const data = await cached("neoforge:meta", () =>
    fetchJson<{ versions: string[] }>("https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge"),
  );
  const byMc = new Map<string, string>();
  for (const version of data.versions) {
    if (/beta|alpha/i.test(version)) continue;
    const parts = version.split(".");
    // NeoForge versions for 1.20.2+ look like <mcMinor>.<mcPatch>.<build>.
    if (parts.length < 3) continue;
    const mc = `1.${parts[0]}.${parts[1]}`;
    byMc.set(mc, version);
  }
  for (const [mc, version] of byMc) {
    if (version.startsWith("26.")) byMc.set("26.3", version);
  }
  return [...byMc.entries()]
    .reverse()
    .map(([mc, recent]) => ({ id: mc, type: "release" as const, javaMajor: javaMajorForMcVersion(mc) }));
}

export async function quiltVersions(): Promise<VersionInfo[]> {
  const data = await cached("quilt:game", () =>
    fetchJson<{ version: string }[]>("https://meta.quiltmc.org/v3/versions/game"),
  );
  return data.map((item) => ({ id: item.version, type: "release" as const, javaMajor: javaMajorForMcVersion(item.version) }));
}

/** Every version list is fetched live from the project's own metadata endpoint. */
export async function listVersions(software: ServerSoftwareId, includeExperimental = false): Promise<VersionInfo[]> {
  switch (software) {
    case "vanilla": return vanillaVersions(includeExperimental);
    case "paper": return paperFamilyVersions("paper", includeExperimental);
    case "folia": return paperFamilyVersions("folia", includeExperimental);
    case "velocity": return paperFamilyVersions("velocity", includeExperimental);
    case "waterfall": return paperFamilyVersions("waterfall", includeExperimental);
    case "purpur": return purpurVersions();
    case "fabric": return fabricVersions();
    case "forge": return forgeVersions();
    case "neoforge": return neoforgeVersions();
    case "quilt": return quiltVersions();
    case "bungeecord":
      return [
        { id: "latest", type: "release", javaMajor: 17 },
        { id: "1.21", type: "release", javaMajor: 17 },
        { id: "1.20", type: "release", javaMajor: 17 },
        { id: "1.19", type: "release", javaMajor: 17 },
      ];
    default:
      throw new ApiException(400, "unknown_software", `Unknown server software: ${software}`);
  }
}

/** Resolves the concrete artifact to download for a given version. */
export async function resolveBuild(software: ServerSoftwareId, version: string): Promise<BuildInfo> {
  switch (software) {
    case "vanilla": return vanillaBuild(version);
    case "paper": return paperFamilyLatestBuild("paper", version);
    case "folia": return paperFamilyLatestBuild("folia", version);
    case "velocity": return paperFamilyLatestBuild("velocity", version);
    case "waterfall": return paperFamilyLatestBuild("waterfall", version);
    case "purpur": return purpurBuild(version);
    case "bungeecord":
      return {
        version, build: "lastSuccessfulBuild",
        url: "https://ci.md-5.net/job/BungeeCord/lastSuccessfulBuild/artifact/bootstrap/target/BungeeCord.jar",
        fileName: "BungeeCord.jar", sha256: null, sha1: null, size: null,
        channel: "ci", javaMinimum: 17, recommendedFlags: null, source: "BungeeCord CI (md-5.net)",
      };
    case "fabric":
    case "forge":
    case "neoforge":
    case "quilt":
      return resolveLoaderInstall(software, version);
    default:
      throw new ApiException(400, "unknown_software", `Unknown server software: ${software}`);
  }
}

async function resolveLoaderInstall(software: ServerSoftwareId, version: string): Promise<BuildInfo> {
  if (software === "fabric") {
    const loaders = await cached(`fabric:loader:${version}`, () =>
      fetchJson<{ loader: { version: string; stable: boolean } }[]>(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}`),
    );
    const loader = loaders.find((item) => item.loader.stable) ?? loaders[0];
    if (!loader) throw new ApiException(404, "unsupported_version", `Fabric has no loader for Minecraft ${version}`);
    const installers = await cached("fabric:installer", () =>
      fetchJson<{ version: string; url: string; stable: boolean }[]>("https://meta.fabricmc.net/v2/versions/installer"),
    );
    const installer = installers.find((item) => item.stable) ?? installers[0];
    if (!installer) throw new ApiException(502, "installer_unavailable", "Fabric installer metadata is unavailable");
    return {
      version, build: loader.loader.version, url: installer.url,
      fileName: `fabric-installer-${installer.version}.jar`,
      sha256: null, sha1: null, size: null, channel: "stable",
      javaMinimum: javaMajorForMcVersion(version), recommendedFlags: null,
      source: "FabricMC meta API",
    };
  }
  if (software === "forge") {
    const data = await cached("forge:meta", () =>
      fetchJson<Record<string, string[]>>("https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json"),
    );
    const builds = data[version];
    if (!builds || builds.length === 0) throw new ApiException(404, "unsupported_version", `Forge has no build for Minecraft ${version}`);
    const build = [...builds].reverse().find((item) => item.startsWith(`${version}-`)) ?? builds[builds.length - 1]!;
    return {
      version, build,
      url: `https://maven.minecraftforge.net/net/minecraftforge/forge/${build}/forge-${build}-installer.jar`,
      fileName: `forge-${build}-installer.jar`,
      sha256: null, sha1: null, size: null, channel: "recommended",
      javaMinimum: javaMajorForMcVersion(version), recommendedFlags: null,
      source: "MinecraftForge maven",
    };
  }
  if (software === "neoforge") {
    const data = await cached("neoforge:meta", () =>
      fetchJson<{ versions: string[] }>("https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge"),
    );
    const parts = version.split(".");
    const prefix = parts.length >= 3 ? `1.${parts[1]}.${parts[2]}.` : `${parts.slice(1).join(".")}.`;
    const candidates = data.versions.filter((item) => item.startsWith(prefix) && !/beta|alpha/i.test(item));
    const build = candidates[candidates.length - 1];
    if (!build) throw new ApiException(404, "unsupported_version", `No stable NeoForge build is published for Minecraft ${version}`);
    return {
      version, build,
      url: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${build}/neoforge-${build}-installer.jar`,
      fileName: `neoforge-${build}-installer.jar`,
      sha256: null, sha1: null, size: null, channel: "stable",
      javaMinimum: javaMajorForMcVersion(version), recommendedFlags: null,
      source: "NeoForged maven",
    };
  }
  // quilt
  const installerMeta = await fetchJson<{ latest: string }>("https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/maven-metadata.xml")
    .catch(() => null as any);
  const installerVersion = installerMeta?.latest ?? "0.15.1";
  return {
    version, build: installerVersion,
    url: `https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/${installerVersion}/quilt-installer-${installerVersion}.jar`,
    fileName: `quilt-installer-${installerVersion}.jar`,
    sha256: null, sha1: null, size: null, channel: "stable",
    javaMinimum: javaMajorForMcVersion(version), recommendedFlags: null,
    source: "QuiltMC maven",
  };
}

/* ---------------------------------------------------------------- */
/* Installation                                                      */
/* ---------------------------------------------------------------- */

export interface InstallResult {
  kind: "server";
  jarFile: string;
  version: string;
  build: string | null;
  sha256: string | null;
  source: string;
  launchScript: string | null;
  javaMinimum: number;
  recommendedFlags: string[] | null;
}

/**
 * Performs the real installation: downloads the artifact (verified when the upstream supplies
 * a checksum), prepares the directory and, for loader-based software, runs the official
 * installer with a managed Java runtime.
 */
/**
 * The Java major a piece of software actually needs.
 *
 * `javaMajorForMcVersion` only understands Minecraft's numbering — a proxy version like
 * Velocity "4.3.0" is not a Minecraft release, so the table answers 21 while the artifact needs
 * Java 25 and dies with UnsupportedClassVersionError. Provider metadata knows best, so ask it.
 */
export async function minimumJavaFor(software: ServerSoftwareId, version: string): Promise<number | null> {
  try {
    const build = await resolveBuild(software, version);
    if (Number.isFinite(build.javaMinimum)) return build.javaMinimum;
  } catch {
    // Offline or upstream hiccup: fall back to the version table.
  }
  return null;
}

export async function installServerSoftware(opts: {
  software: ServerSoftwareId;
  version: string;
  directory: string;
  javaExecutable: string;
  onProgress?: (stage: string, received: number, total: number) => void;
  serverId?: number;
}): Promise<InstallResult> {
  const definition = softwareDefinition(opts.software);
  const build = await resolveBuild(opts.software, opts.version);
  ensureDir(opts.directory);
  const artifactPath = join(opts.directory, build.fileName);

  opts.onProgress?.(`Downloading ${definition.name} ${opts.version}`, 0, build.size ?? 0);
  const download = await downloadFile({
    url: build.url,
    destination: artifactPath,
    expectedSha256: build.sha256,
    expectedSha1: build.sha1,
    expectedSize: build.size,
    label: `${definition.name} ${opts.version}`,
    serverId: opts.serverId ?? null,
    onProgress: (received, total) => opts.onProgress?.(`Downloading ${definition.name} ${opts.version}`, received, total),
  });

  if (definition.installerBased) {
    opts.onProgress?.(`Running ${definition.name} installer`, 0, 0);
    const result = runInstaller(opts.software, build, opts.directory, opts.javaExecutable, opts.version);
    if (!result.ok) {
      throw new ApiException(500, "installer_failed", `${definition.name} installer failed: ${result.message}`);
    }
    const launchScript = detectLauncher(opts.directory, opts.software);
    return {
      kind: "server", jarFile: launchScript ?? result.launchJar ?? build.fileName,
      version: opts.version, build: build.build, sha256: download.sha256,
      source: build.source, launchScript: launchScript ?? null,
      javaMinimum: build.javaMinimum ?? javaMajorForMcVersion(opts.version),
      recommendedFlags: build.recommendedFlags,
    };
  }

  const jarPath = join(opts.directory, "server.jar");
  if (artifactPath !== jarPath) {
    movePath(artifactPath, jarPath);
  }
  writeEula(opts.directory);
  return {
    kind: "server", jarFile: "server.jar", version: opts.version, build: build.build,
    sha256: download.sha256, source: build.source, launchScript: null,
    javaMinimum: build.javaMinimum ?? javaMajorForMcVersion(opts.version),
    recommendedFlags: build.recommendedFlags,
  };
}

function writeEula(directory: string): void {
  // The EULA is accepted by the administrator in the creation wizard; see docs/EULA.md.
  writeFileAtomic(join(directory, "eula.txt"), "# Accepted through RSLMC during server creation\neula=true\n");
}

function runInstaller(
  software: ServerSoftwareId, build: BuildInfo, directory: string, javaExecutable: string, version: string,
): { ok: boolean; message: string; launchJar?: string } {
  const installerPath = join(directory, build.fileName);
  const argsByVendor: Record<string, string[]> = {
    fabric: ["-jar", installerPath, "server", "-mcversion", version, "-downloadMinecraft", "-dir", directory],
    forge: ["-jar", installerPath, "--installServer", directory],
    neoforge: ["-jar", installerPath, "--installServer", directory],
    quilt: ["-jar", installerPath, "install", "server", version, "--install-dir=" + directory, "--download-dir=" + directory],
  };
  const args = argsByVendor[software];
  if (!args) return { ok: false, message: "no installer recipe for this software" };
  const proc = Bun.spawnSync([javaExecutable, ...args], {
    cwd: directory, stdout: "pipe", stderr: "pipe", timeout: 8 * 60 * 1000,
  });
  if (proc.exitCode !== 0) {
    const output = `${proc.stdout.toString()}${proc.stderr.toString()}`.trim().slice(-1200);
    return { ok: false, message: output || `installer exited with code ${proc.exitCode}` };
  }
  return { ok: true, message: "installed", launchJar: detectLauncher(directory, software) ?? undefined };
}

export function detectLauncher(directory: string, software: ServerSoftwareId): string | null {
  if (!existsSync(directory)) return null;
  const entries = readdirSync(directory);
  const isWindows = process.platform === "win32";
  if (software === "forge" || software === "neoforge") {
    const script = entries.find((entry) => entry === (isWindows ? "run.bat" : "run.sh"));
    return script ?? null;
  }
  if (software === "fabric") {
    const generated = entries.find((entry) => /^fabric-server.*\.jar$/.test(entry));
    if (generated) return generated;
    return entries.includes("fabric-server-launch.jar") ? "fabric-server-launch.jar" : null;
  }
  if (software === "quilt") {
    return entries.find((entry) => /^quilt-server.*\.jar$/.test(entry)) ?? null;
  }
  const jar = entries.find((entry) => entry === "server.jar");
  return jar ?? null;
}

export function softwareSupportsMarketplace(id: ServerSoftwareId, kind: "plugin" | "mod"): boolean {
  const definition = softwareDefinition(id);
  return kind === "plugin" ? definition.supportsPlugins : definition.supportsMods;
}

export function directoryHasAnyJar(directory: string): boolean {
  if (!existsSync(directory)) return false;
  return readdirSync(directory).some((entry) => {
    try { return entry.endsWith(".jar") && statSync(join(directory, entry)).isFile(); } catch { return false; }
  });
}

import { chmodSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { ensureDir, movePath, directorySize } from "../shared/platform";
import { extractTarGzStreaming, extractZipStreaming } from "../shared/archive";
import { join } from "node:path";
import { PATHS, hostPlatform, MODE } from "../shared/config";
import { query, queryOne, insert, run } from "../database";
import { downloadFile, fetchJson, assertTrustedUrl } from "../services/download";
import { ApiException } from "../shared/http";
import type { JavaRuntimeInfo } from "../shared/types";
import { notify } from "../services/notifications";

/** Java majors RSLMC can provision. Adoptium publishes releases for all of these. */
export const SUPPORTED_JAVA_MAJORS = [8, 11, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25] as const;
export type JavaMajor = (typeof SUPPORTED_JAVA_MAJORS)[number];

interface AdoptiumAsset {
  binary: {
    package: {
      link: string;
      checksum: string;
      size: number;
      name: string;
    };
    os: string;
    architecture: string;
    image_type: string;
    updated_at: string;
  };
  release_name: string;
  version: { semver: string; major: number; openjdk_version: string };
  vendor: string;
}

const adoptiumOs = (): string => {
  const platform = hostPlatform();
  return platform.os === "windows" ? "windows" : platform.os === "darwin" ? "mac" : "linux";
};

const adoptiumArch = (): string => {
  const platform = hostPlatform();
  return platform.arch === "arm64" ? "aarch64" : "x64";
};

export function runtimeDirectory(major: number, imageType = "jdk"): string {
  const platform = hostPlatform();
  return join(PATHS.java, `${platform.label}`, `temurin-${major}-${imageType}`);
}

export function javaExecutablePath(installDir: string): string {
  const platform = hostPlatform();
  if (platform.os === "windows") return join(installDir, "bin", "java.exe");
  return join(installDir, "bin", "java");
}

let releaseCache: { at: number; data: number[] } | null = null;

export async function availableAdoptiumReleases(): Promise<number[]> {
  if (releaseCache && Date.now() - releaseCache.at < 10 * 60 * 1000) return releaseCache.data;
  const data = await fetchJson<{ available_releases: number[] }>("https://api.adoptium.net/v3/info/available_releases");
  releaseCache = { at: Date.now(), data: data.available_releases ?? [] };
  return releaseCache.data;
}

function mapRuntime(row: any): JavaRuntimeInfo {
  return {
    id: row.id,
    nodeId: row.node_id,
    major: row.major,
    vendor: row.vendor,
    version: row.version,
    os: row.os,
    arch: row.arch,
    imageType: row.image_type,
    path: row.path,
    sizeBytes: row.size_bytes,
    checksum: row.checksum,
    status: row.status,
    verifiedAt: row.verified_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}

/**
 * Runtimes installed by this panel have `node_id = NULL` (they live on the local host), while a
 * server always carries a concrete node id. Filtering on equality alone hid every local runtime
 * from node-scoped callers — Settings then claimed "Java 21 is not installed" next to an installed
 * Java 21. Treat NULL as local and match both.
 */
export function listRuntimes(nodeId?: number): JavaRuntimeInfo[] {
  const rows = nodeId
    ? query("SELECT * FROM java_runtimes WHERE node_id = ? OR node_id IS NULL ORDER BY major DESC", [nodeId])
    : query("SELECT * FROM java_runtimes ORDER BY major DESC");
  return rows.map(mapRuntime);
}

export function findRuntimeForMajor(major: number, nodeId?: number): JavaRuntimeInfo | null {
  const row = queryOne(
    `SELECT * FROM java_runtimes WHERE major = ? AND status IN ('installed','verified')
     ${nodeId ? "AND (node_id = ? OR node_id IS NULL)" : ""} ORDER BY (status = 'verified') DESC, id DESC LIMIT 1`,
    nodeId ? [major, nodeId] : [major],
  );
  return row ? mapRuntime(row) : null;
}

/**
 * Extracts a Temurin archive. Adoptium ships `.tar.gz` on Linux and `.zip` on Windows —
 * picking the extractor by the real file signature keeps Windows installs working without
 * a `tar`/`unzip` binary on PATH.
 */
export async function extractJavaArchive(archivePath: string, destination: string): Promise<void> {
  try {
    const head = readFileSync(archivePath).subarray(0, 4);
    const isZip = (head[0] === 0x50 && head[1] === 0x4b)                      // "PK"
      || (!(head[0] === 0x1f && head[1] === 0x8b) && archivePath.toLowerCase().endsWith(".zip"));
    // The zip path streams entry by entry: a Windows JDK is ~200 MB compressed and would
    // otherwise be held in memory twice while inflating.
    // Both paths stream: a JDK is ~200 MB compressed and would otherwise be inflated entirely
    // in memory, which is enough to get a small host OOM-killed during installation.
    if (isZip) await extractZipStreaming(archivePath, destination);
    else await extractTarGzStreaming(archivePath, destination);
  } catch (error) {
    throw new ApiException(500, "extract_failed", `Failed to extract Java archive: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400));
  }
}

export interface InstallProgress { stage: string; progress: number; total: number }

/**
 * Downloads, verifies and installs an Eclipse Temurin runtime for the requested major version.
 * Installation is atomic: the archive is verified before extraction and the runtime is only
 * registered once a working `java -version` succeeds.
 */
/**
 * Reads the major version out of `java -version` output.
 *
 * Java 8 and older print the legacy scheme — `openjdk version "1.8.0_432"` — where the first number
 * is always 1 and the real feature release is the *second* component. Naively taking the leading
 * digits reported "Java 1" for a perfectly good Java 8 runtime and aborted the install.
 */
export function parseJavaMajor(versionText: string): number | null {
  const match = /version "([^"]+)"/i.exec(versionText);
  if (!match) return null;
  const parts = match[1]!.split(/[._+\-]/).filter(Boolean);
  const first = Number(parts[0]);
  if (!Number.isInteger(first) || first <= 0) return null;
  if (first === 1) {
    // Legacy "1.<feature>.<patch>_<build>" numbering.
    const second = Number(parts[1]);
    return Number.isInteger(second) && second > 0 ? second : null;
  }
  return first;
}

export async function installRuntime(
  major: number,
  opts: { nodeId?: number | null; imageType?: "jdk" | "jre"; onProgress?: (p: InstallProgress) => void } = {},
): Promise<JavaRuntimeInfo> {
  if (!SUPPORTED_JAVA_MAJORS.includes(major as JavaMajor)) {
    throw new ApiException(400, "unsupported_java", `Java ${major} is not a selectable major version in RSLMC`);
  }
  const imageType = opts.imageType ?? "jdk";
  const platform = hostPlatform();
  if (platform.os === "darwin") {
    throw new ApiException(400, "unsupported_platform", "macOS hosts are not a supported RSLMC server platform");
  }

  const releases = await availableAdoptiumReleases().catch(() => [] as number[]);
  if (releases.length > 0 && !releases.includes(major)) {
    throw new ApiException(400, "java_not_published", `Adoptium does not publish Java ${major} for ${platform.label}`);
  }

  const apiUrl =
    `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=${adoptiumArch()}` +
    `&image_type=${imageType}&os=${adoptiumOs()}&vendor=eclipse`;
  const assets = await fetchJson<AdoptiumAsset[]>(apiUrl, 30_000);
  const asset = assets.find((item) => item.binary.image_type === imageType) ?? assets[0];
  if (!asset) throw new ApiException(502, "java_unavailable", `No Eclipse Temurin build found for Java ${major} on ${platform.label}`);

  const downloadUrl = assertTrustedUrl(asset.binary.package.link);
  const installDir = runtimeDirectory(major, imageType);
  // Keep the vendor's real extension: Temurin is .tar.gz on Linux and .zip on Windows.
  const archiveName = asset.binary.package.name;
  const archivePath = join(PATHS.downloads, archiveName);

  opts.onProgress?.({ stage: `Downloading Temurin ${major}`, progress: 0, total: asset.binary.package.size });
  const downloaded = await downloadFile({
    url: downloadUrl.toString(),
    destination: archivePath,
    expectedSha256: asset.binary.package.checksum,
    expectedSize: asset.binary.package.size,
    label: `Java ${major} runtime`,
    onProgress: (received, total) => opts.onProgress?.({ stage: `Downloading Temurin ${major}`, progress: received, total }),
  });

  if (existsSync(installDir)) rmSync(installDir, { recursive: true, force: true });
  const stagingDir = join(PATHS.temporary, `java-${major}-${Date.now()}`);
  ensureDir(stagingDir);
  opts.onProgress?.({ stage: "Extracting runtime", progress: downloaded.size, total: downloaded.size });
  try {
    await extractJavaArchive(archivePath, stagingDir);
  } catch (err) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }

  // Temurin archives wrap contents in a single top-level directory.
  const entries = readdirSync(stagingDir);
  const rootEntry = entries.find((entry) => statSync(join(stagingDir, entry)).isDirectory());
  if (!rootEntry) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw new ApiException(500, "extract_failed", "Java archive did not contain a runtime directory");
  }
  ensureDir(join(installDir, ".."));
  try {
    movePath(join(stagingDir, rootEntry), installDir);
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw new ApiException(500, "install_failed", `Could not move the Java runtime into place: ${error instanceof Error ? error.message : String(error)}`);
  }
  rmSync(stagingDir, { recursive: true, force: true });
  try { rmSync(archivePath, { force: true }); } catch { /* ignore */ }

  const javaBin = javaExecutablePath(installDir);
  if (!existsSync(javaBin)) {
    throw new ApiException(500, "install_failed", `Java executable missing at ${javaBin}`);
  }
  const versionCheck = Bun.spawnSync([javaBin, "-version"], { stdout: "pipe", stderr: "pipe" });
  if (versionCheck.exitCode !== 0) {
    rmSync(installDir, { recursive: true, force: true });
    throw new ApiException(500, "install_failed", "Installed Java runtime failed to execute");
  }
  const versionText = `${versionCheck.stdout.toString()}${versionCheck.stderr.toString()}`;
  const version = /version "([^"]+)"/.exec(versionText)?.[1] ?? asset.release_name;

  // Verify the extracted runtime actually reports the expected major version.
  const reportedMajor = parseJavaMajor(versionText);
  if (reportedMajor !== null && reportedMajor !== major) {
    rmSync(installDir, { recursive: true, force: true });
    throw new ApiException(500, "install_failed", `Runtime reports Java ${reportedMajor} but Java ${major} was requested`);
  }
  if (reportedMajor === null) {
    // Unparseable banner is not proof of a mismatch — keep the runtime but say so in the log.
    console.warn(`[rslmc] could not read the major version from ${javaBin} -version output; trusting the requested Java ${major}`);
  }

  runtimeHealth.set(installDir, true);
  const sizeBytes = directorySize(installDir);

  const existing = queryOne<{ id: number }>(
    "SELECT id FROM java_runtimes WHERE major = ? AND os = ? AND arch = ? AND image_type = ? AND (node_id IS ? OR node_id = ?)",
    [major, platform.os, platform.arch, imageType, opts.nodeId ?? null, opts.nodeId ?? null],
  );

  let id: number;
  if (existing) {
    run(
      `UPDATE java_runtimes SET version = ?, path = ?, java_executable = ?, size_bytes = ?, checksum = ?,
       status = 'verified', verified_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), vendor = 'Eclipse Temurin' WHERE id = ?`,
      [version, installDir, javaBin, sizeBytes, downloaded.sha256, existing.id],
    );
    id = existing.id;
  } else {
    id = insert(
      `INSERT INTO java_runtimes (node_id, major, vendor, version, os, arch, image_type, path, java_executable,
        size_bytes, checksum, status, verified_at)
       VALUES (?, ?, 'Eclipse Temurin', ?, ?, ?, ?, ?, ?, ?, ?, 'verified', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      [opts.nodeId ?? null, major, version, platform.os, platform.arch, imageType, installDir, javaBin, sizeBytes, downloaded.sha256],
    );
  }
  opts.onProgress?.({ stage: "Java runtime ready", progress: downloaded.size, total: downloaded.size });
  return mapRuntime(queryOne("SELECT * FROM java_runtimes WHERE id = ?", [id]));
}

/**
 * Extraction, copying and some container/snapshot restores can drop the executable bit from the
 * runtime binaries. Repair it when possible instead of failing the start with EACCES.
 */
function ensureExecutable(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    const mode = statSync(path).mode;
    if ((mode & 0o111) === 0) chmodSync(path, mode | 0o755);
    return true;
  } catch {
    return false;
  }
}

/**
 * Proves a runtime can actually run. `bin/java` existing and being executable is not enough: an
 * install interrupted by an OOM kill or a full disk leaves a truncated tree that fails later with
 * "error while loading shared libraries: libjli.so" or "NoClassDefFoundError: java/lang/Object".
 * Checking once per process keeps the cost at a single `java -version` spawn.
 */
const runtimeHealth = new Map<string, boolean>();

function runtimeRuns(path: string): boolean {
  const cached = runtimeHealth.get(path);
  if (cached !== undefined) return cached;
  const executable = javaExecutablePath(path);
  if (!ensureExecutable(executable)) return false;
  let ok = false;
  try {
    const result = Bun.spawnSync([executable, "-version"], { stdout: "pipe", stderr: "pipe" });
    const text = `${result.stdout.toString()}${result.stderr.toString()}`;
    ok = result.exitCode === 0 && /version\s+"?\d/.test(text);
  } catch {
    ok = false;
  }
  runtimeHealth.set(path, ok);
  return ok;
}

/** A runtime is only usable when its `bin/java` actually runs (`java -version` exits 0). */
export function runtimeIsUsable(runtime: JavaRuntimeInfo | null | undefined): boolean {
  if (!runtime) return false;
  if (!resolveExecutable(runtime)) return false;
  if (!existsSync(runtime.path)) return false;
  return runtimeRuns(runtime.path);
}

export function invalidateRuntimeHealth(path?: string): void {
  if (path) runtimeHealth.delete(path);
  else runtimeHealth.clear();
}

export async function ensureRuntime(major: number, nodeId?: number): Promise<JavaRuntimeInfo> {
  const existing = findRuntimeForMajor(major, nodeId);
  if (existing && existsSync(existing.path)) {
    if (runtimeRuns(existing.path)) {
      run("UPDATE java_runtimes SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", [existing.id]);
      return existing;
    }
    // Broken on disk (interrupted extraction, wiped lib/): replace it instead of failing forever.
    runtimeHealth.delete(existing.path);
    try { rmSync(existing.path, { recursive: true, force: true }); } catch { /* ignore */ }
    run("UPDATE servers SET java_runtime_id = NULL WHERE java_runtime_id = ?", [existing.id]);
    run("DELETE FROM java_runtimes WHERE id = ?", [existing.id]);
  }
  return installRuntime(major, { nodeId });
}

export function removeRuntime(id: number): void {
  const row = queryOne<any>("SELECT * FROM java_runtimes WHERE id = ?", [id]);
  if (!row) throw new ApiException(404, "not_found", "Java runtime not found");
  const inUse = queryOne<{ c: number }>("SELECT COUNT(*) AS c FROM servers WHERE java_runtime_id = ?", [id])?.c ?? 0;
  if (inUse > 0) throw new ApiException(409, "runtime_in_use", `This runtime is used by ${inUse} server(s)`);
  if (row.path && row.path.startsWith(PATHS.java)) rmSync(row.path, { recursive: true, force: true });
  run("DELETE FROM java_runtimes WHERE id = ?", [id]);
}

export function runtimeInfo(id: number): JavaRuntimeInfo | null {
  const row = queryOne("SELECT * FROM java_runtimes WHERE id = ?", [id]);
  return row ? mapRuntime(row) : null;
}

export function resolveExecutable(runtime: JavaRuntimeInfo | null): string | null {
  if (!runtime) return null;
  const candidate = join(runtime.path, "bin", hostPlatform().os === "windows" ? "java.exe" : "java");
  return ensureExecutable(candidate) ? candidate : null;
}

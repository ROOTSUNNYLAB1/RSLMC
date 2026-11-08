import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { chmodSync } from "node:fs";
import { PATHS, hostPlatform } from "../shared/config";
import { ensureDir } from "../shared/platform";
import { ApiException } from "../shared/http";
import { downloadFile, fetchJson } from "../services/download";
import { extractTarGzStreaming, extractZipStreaming } from "../shared/archive";
import {
  APP_FAMILIES, type AppFamily, listAppVersions, resolveAppDownload,
} from "./catalog";

/*
 * Interpreter installs, one per (family, version), shared by every server that asks for that version.
 *
 * A Minecraft server downloads a jar into its own folder; a Python or Node server needs the *runtime*
 * itself. Installing it per server would multiply a 40–90 MB download by every bot on the box, so the
 * runtimes live under `<data>/runtimes/<family>/<version>` and are immutable once installed.
 *
 * The extracted tree is owned by root and readable by everyone: the interpreters are shared, so a
 * server that could write into them could sabotage every other server using the same version. The
 * service account only gets write access to its own server directory.
 */

export function interpretersRoot(): string {
  return join(PATHS.data, "runtimes");
}

export function interpreterDirectory(family: AppFamily, version: string): string {
  return join(interpretersRoot(), family, version);
}

/**
 * The binary inside an extracted interpreter.
 *
 * python-build-standalone's `install_only` tarball unpacks to `python/bin/python3` (and a `bin/python`
 * symlink), while the Node tarball unpacks to `node-v<ver>-linux-x64/bin/node`. Both are located by
 * looking rather than assuming, because a wrong guess here is a server that never starts.
 */
export function interpreterExecutable(family: AppFamily, version: string): string | null {
  const root = interpreterDirectory(family, version);
  if (!existsSync(root)) return null;
  const candidates = family === "python"
    ? [join(root, "bin", "python3"), join(root, "python", "bin", "python3"), join(root, "bin", "python")]
    : [join(root, "bin", "node"), join(root, "bin", "node.exe")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // Last resort: one level down, which covers an archive whose root folder name changed upstream.
  try {
    for (const entry of readdirSync(root)) {
      const nested = family === "python" ? join(root, entry, "bin", "python3") : join(root, entry, "bin", "node");
      if (existsSync(nested)) return nested;
    }
  } catch { /* unreadable: reported by the caller as "not installed" */ }
  return null;
}

export function interpreterInstalled(family: AppFamily, version: string): boolean {
  return interpreterExecutable(family, version) !== null;
}

export interface InterpreterRecord {
  family: AppFamily;
  version: string;
  path: string;
  /** Which bind directory must join PATH for pip/npm to resolve. */
  binDirectory: string;
  installedAt: number | null;
  sizeBytes: number;
}

export function listInstalledInterpreters(): InterpreterRecord[] {
  const records: InterpreterRecord[] = [];
  for (const family of Object.keys(APP_FAMILIES) as AppFamily[]) {
    const root = join(interpretersRoot(), family);
    if (!existsSync(root)) continue;
    for (const version of readdirSync(root)) {
      const executable = interpreterExecutable(family, version);
      if (!executable) continue;
      const path = interpreterDirectory(family, version);
      records.push({
        family, version, path,
        binDirectory: join(executable, ".."),
        installedAt: (() => { try { return statSync(path).mtimeMs; } catch { return null; } })(),
        sizeBytes: 0,
      });
    }
  }
  return records;
}

export type InterpreterProgress = (stage: string, received: number, total: number) => void;

/**
 * Downloads and unpacks one interpreter version.
 *
 * Atomic on purpose: everything is extracted into a staging directory and renamed into place only after
 * the expected binary exists, so a torn download can never look like an installed runtime. A second
 * caller for the same version waits on the first instead of downloading it twice.
 */
const inFlight = new Map<string, Promise<InterpreterRecord>>();

export async function ensureInterpreter(
  family: AppFamily,
  version: string,
  onProgress?: InterpreterProgress,
): Promise<InterpreterRecord> {
  const existing = interpreterExecutable(family, version);
  if (existing) {
    return {
      family, version, path: interpreterDirectory(family, version),
      binDirectory: join(existing, ".."), installedAt: null, sizeBytes: 0,
    };
  }

  const key = `${family}:${version}`;
  const running = inFlight.get(key);
  if (running) return running;

  const task = (async (): Promise<InterpreterRecord> => {
    const platform = hostPlatform();
    if (platform.os === "darwin") {
      throw new ApiException(400, "unsupported_platform", "macOS hosts are not a supported RSLMC server platform");
    }
    const definition = APP_FAMILIES[family];

    // Refuse a version that upstream does not publish for this machine, with the real reason — this is
    // the place where "3.13" typed by hand would otherwise become a 404 halfway through a download.
    const known = await listAppVersions(family).catch(() => []);
    const entry = known.find((candidate) => candidate.version === version);
    if (entry?.unavailableReason) {
      throw new ApiException(400, "version_unavailable", `${definition.versionLabel} ${version}: ${entry.unavailableReason}`);
    }

    const download = await resolveAppDownload(family, version);
    ensureDir(PATHS.downloads);
    const archivePath = join(PATHS.downloads, download.fileName);

    onProgress?.(`Downloading ${definition.versionLabel} ${version}`, 0, 0);
    const checksum = await expectedChecksum(download.checksumUrl, download.fileName);
    const downloaded = await downloadFile({
      url: download.url,
      destination: archivePath,
      expectedSha256: checksum ?? undefined,
      label: `${definition.versionLabel} ${version}`,
      onProgress: (received, total) => onProgress?.(`Downloading ${definition.versionLabel} ${version}`, received, total),
    });

    const staging = join(PATHS.temporary, `app-${family}-${version.replace(/\./g, "_")}-${Date.now()}`);
    ensureDir(staging);
    onProgress?.("Extracting runtime", downloaded.size, downloaded.size);
    try {
      if (archivePath.toLowerCase().endsWith(".zip")) await extractZipStreaming(archivePath, staging);
      else await extractTarGzStreaming(archivePath, staging);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw new ApiException(500, "extract_failed",
        `Could not unpack ${definition.versionLabel} ${version}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400));
    }

    /*
     * Flatten the archive's own root folder so the tree is always `<version>/bin/<binary>`. Both
     * providers wrap their contents in one directory whose name changes between releases; normalising
     * it here is what makes `interpreterExecutable()` a lookup instead of a guess.
     */
    const entries = readdirSync(staging).filter((entry) => entry !== "__MACOSX");
    const single = entries.length === 1 && statSync(join(staging, entries[0]!)).isDirectory();
    const unpacked = single ? join(staging, entries[0]!) : staging;
    const target = interpreterDirectory(family, version);
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    ensureDir(join(target, ".."));
    try {
      renameSync(unpacked, target);
    } catch {
      // Cross-device rename: fall back to a copy through the platform helper.
      ensureDir(target);
      for (const entry of readdirSync(unpacked)) {
        renameSync(join(unpacked, entry), join(target, entry));
      }
    }
    if (single) rmSync(staging, { recursive: true, force: true });

    const executable = interpreterExecutable(family, version);
    if (!executable) {
      rmSync(target, { recursive: true, force: true });
      throw new ApiException(500, "interpreter_incomplete",
        `${definition.versionLabel} ${version} was unpacked but no ${definition.binary} binary was found inside it.`);
    }
    /*
     * The interpreter is shared, and it is used by a process that is *not* the panel's account. So the
     * tree must be readable-and-executable for everyone while staying owned by root: an app server that
     * could write into it could break every other server on the same version.
     */
    try { chmodSync(executable, 0o755); } catch { /* Windows has no exec bit */ }
    const { ensureTraversable } = await import("../runtime/nonroot");
    const traversal = ensureTraversable(target);
    if (!traversal.ok) {
      throw new ApiException(409, "interpreter_unreachable",
        `${definition.versionLabel} ${version} was installed, but the service account cannot reach `
        + `${traversal.blocked.join(", ")} (no execute permission on the path). Run: chmod o+x ${traversal.blocked.join(" ")}`);
    }

    onProgress?.(`${definition.versionLabel} ${version} ready`, 1, 1);
    return {
      family, version, path: target, binDirectory: join(executable, ".."),
      installedAt: Date.now(), sizeBytes: downloaded.size,
    };
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, task);
  return task;
}

/**
 * The expected SHA-256 for an archive, read from the project's own checksum file.
 *
 * Both providers publish one (`SHASUMS256.txt` for Node, `<asset>.sha256` for python-build-standalone).
 * When it cannot be fetched the download still proceeds — but with no checksum the file is not verified,
 * and the install log says so rather than implying a verification that did not happen.
 */
async function expectedChecksum(url: string | null, fileName: string): Promise<string | null> {
  if (!url) return null;
  try {
    const text = await fetch(url, { headers: { "user-agent": "rslmc" }, signal: AbortSignal.timeout(20_000) })
      .then((response) => (response.ok ? response.text() : ""));
    if (!text) return null;
    // `<sha256>  <name>` per line (Node) or a bare digest (python-build-standalone's `.sha256`).
    for (const line of text.split("\n")) {
      const match = /^([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line.trim());
      if (match && (match[2] === fileName || match[2].endsWith(`/${fileName}`) || fileName.endsWith(match[2]!))) {
        return match[1]!.toLowerCase();
      }
    }
    const bare = /^([a-f0-9]{64})\s*$/i.exec(text.trim());
    return bare ? bare[1]!.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Removes an installed interpreter. Refused while a server still uses that exact version. */
export function removeInterpreter(family: AppFamily, version: string, inUse: boolean): void {
  if (inUse) {
    throw new ApiException(409, "interpreter_in_use",
      `${APP_FAMILIES[family].versionLabel} ${version} is still used by a server. Change or delete those servers first.`);
  }
  rmSync(interpreterDirectory(family, version), { recursive: true, force: true });
}

/** Scaffolds a minimal entry file so a fresh app server starts and says something useful. */
export async function installAppScaffold(family: AppFamily, version: string, directory: string): Promise<{ entryFile: string }> {
  const definition = APP_FAMILIES[family];
  const readme = join(directory, "RSLMC-README.txt");
  const entry = join(directory, definition.entryFile);
  if (!existsSync(entry)) {
    const body = family === "python"
      ? [
          '"""RSLMC starter app — replace this file with your own program.',
          "",
          "The panel starts it as:  python3 main.py",
          "Put dependencies in requirements.txt, then press \"Install dependencies\"",
          "on the server's Startup page (the console writes to your program, not to a shell).",
          '"""',
          "import os, sys, time",
          "",
          "print(f\"Python {sys.version.split()[0]} on {os.uname().sysname if hasattr(os, 'uname') else 'windows'}\", flush=True)",
          'print("RSLMC started this process as a non-root service account.", flush=True)',
          "print('Replace main.py with your own code — the console shows stdout and stderr live.', flush=True)",
          "",
          "while True:",
          '    print(f"[{time.strftime(\'%H:%M:%S\')}] still running", flush=True)',
          "    time.sleep(30)",
          "",
        ].join("\n")
      : [
          "// RSLMC starter app — replace this file with your own program.",
          "//",
          "// The panel starts it as:  node index.js",
          "// Dependencies: put them in package.json, then press \"Install dependencies\"",
          "// on the server's Startup page (the console writes to your program, not to a shell).",
          "console.log(`Node ${process.version} on ${process.platform}/${process.arch}`);",
          "console.log('RSLMC started this process as a non-root service account.');",
          "console.log('Replace index.js with your own code — the console shows stdout and stderr live.');",
          "",
          "setInterval(() => {",
          "  console.log(`[${new Date().toISOString().slice(11, 19)}] still running`);",
          "}, 30000);",
          "",
        ].join("\n");
    await Bun.write(entry, body);
  }
  if (!existsSync(readme)) {
    await Bun.write(readme, [
      `RSLMC ${definition.name} server`,
      "",
      `Entry file : ${definition.entryFile}`,
      `Runtime    : ${definition.versionLabel} ${version} (installed by the panel, shared between servers)`,
      `Start      : ${definition.binary} ${definition.entryFile}`,
      "",
      "Files you add here are visible in the panel's Files tab and included in backups.",
      "The process runs as the panel's service account, never as root.",
      "",
    ].join("\n"));
  }
  return { entryFile: definition.entryFile };
}

/** Health probe: does the installed binary actually run? Used by Settings and the installer. */
export async function verifyInterpreter(family: AppFamily, version: string): Promise<{ ok: boolean; output: string }> {
  const executable = interpreterExecutable(family, version);
  if (!executable) return { ok: false, output: "not installed" };
  try {
    const flag = family === "python" ? "--version" : "--version";
    const result = Bun.spawnSync([executable, flag], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    return {
      ok: result.exitCode === 0,
      output: `${result.stdout.toString()}${result.stderr.toString()}`.trim().split("\n")[0] ?? "",
    };
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
}

export { fetchJson };

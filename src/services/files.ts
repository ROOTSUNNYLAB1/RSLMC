import { existsSync, readdirSync, statSync, mkdirSync, rmSync, renameSync, copyFileSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { serverDir, PATHS } from "../shared/config";
import { resolveServerPath, sanitizeRelative, isInside } from "../security/paths";
import { createTarGz, extractTarGz, extractZip } from "../shared/archive";
import { copyPath, directorySize } from "../shared/platform";
import { ApiException } from "../shared/http";
import { queryOne } from "../database";
import { parseProperties, escapePropertyValue } from "../minecraft/properties";
import type { FileEntry } from "../shared/types";

const MAX_EDIT_BYTES = 5 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

export function serverRoot(serverId: number): string {
  const server = queryOne<{ uuid: string }>("SELECT uuid FROM servers WHERE id = ?", [serverId]);
  if (!server) throw new ApiException(404, "server_not_found", "Server not found");
  const dir = serverDir(server.uuid);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const EDITABLE_EXTENSIONS = new Set([
  "txt", "properties", "yml", "yaml", "json", "json5", "toml", "conf", "cfg", "ini", "log",
  "sh", "bat", "cmd", "md", "xml", "html", "css", "js", "ts", "csv", "snbt", "mcmeta", "mcfunction", "lang",
]);

export function listDirectory(serverId: number, path: string): { path: string; entries: FileEntry[]; parent: string | null } {
  const root = serverRoot(serverId);
  const target = resolveServerPath(root, path);
  if (!existsSync(target)) throw new ApiException(404, "not_found", "Directory not found");
  if (!statSync(target).isDirectory()) throw new ApiException(400, "not_a_directory", "Path is not a directory");

  const entries: FileEntry[] = [];
  for (const name of readdirSync(target)) {
    const full = join(target, name);
    let stat;
    try { stat = Bun.file(full).size >= 0 ? statSync(full) : statSync(full); } catch { continue; }
    const isDir = stat.isDirectory();
    const extension = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
    entries.push({
      name,
      path: sanitizeRelative(join(path, name)),
      type: stat.isSymbolicLink() ? "symlink" : isDir ? "directory" : "file",
      size: isDir ? 0 : stat.size,
      modifiedAt: stat.mtimeMs,
      mode: (stat.mode & 0o777).toString(8),
      editable: !isDir && (EDITABLE_EXTENSIONS.has(extension) || extension === "") && stat.size <= MAX_EDIT_BYTES,
    });
  }
  entries.sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (b.type === "directory" && a.type !== "directory") return 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
  const clean = sanitizeRelative(path);
  return {
    path: clean,
    entries,
    parent: clean === "" ? null : sanitizeRelative(dirname(clean) === "." ? "" : dirname(clean)),
  };
}

export function readFile(serverId: number, path: string): { path: string; content: string; size: number; modifiedAt: number } {
  const root = serverRoot(serverId);
  const target = resolveServerPath(root, path, { mustExist: true });
  const stat = statSync(target);
  if (stat.isDirectory()) throw new ApiException(400, "is_directory", "Path is a directory");
  if (stat.size > MAX_EDIT_BYTES) throw new ApiException(413, "file_too_large", "File is too large to edit in the browser (limit 5 MB)");
  const buffer = readFileSync(target);
  if (buffer.subarray(0, 8000).includes(0)) throw new ApiException(400, "binary_file", "Binary files cannot be edited as text");
  return { path: sanitizeRelative(path), content: buffer.toString("utf8"), size: stat.size, modifiedAt: stat.mtimeMs };
}

/**
 * RSLMC owns the listening address of a server: `server-ip` and `server-port` are derived from the
 * allocation, and the typed Properties editor already marks them as managed. The raw file editor used
 * to be a side door around that — a plain account could write `server-port=22` into
 * `server.properties` and move the server onto a port the panel does not own (or fight another
 * server for the same one).
 *
 * Rather than refusing the whole save (which would make the editor frustrating and still leaves
 * upload/extract open), the managed keys are restored to their allocated values and the caller is told
 * what was kept. Admins change these through Networking → Allocations, which also updates the DB.
 */
export function enforceManagedProperties(serverId: number, content: string): { content: string; kept: string[] } {
  const row = queryOne<{ port: number; bind_ip: string }>("SELECT port, bind_ip FROM servers WHERE id = ?", [serverId]);
  if (!row) return { content, kept: [] };
  const managed: Record<string, string> = {
    "server-port": String(row.port),
    "server-ip": row.bind_ip || "0.0.0.0",
  };
  const kept: string[] = [];
  const lines = content.split(/\r?\n/);
  const seen = new Set<string>();
  const output = lines.map((line) => {
    const match = /^\s*([^#!=\s][^=:]*?)\s*[=:]/.exec(line);
    if (!match) return line;
    const key = match[1]!.trim();
    if (!(key in managed)) return line;
    seen.add(key);
    const current = line.slice(line.indexOf("=") + 1).trim();
    if (current === escapePropertyValue(managed[key]!)) return line;
    kept.push(key);
    return `${key}=${escapePropertyValue(managed[key]!)}`;
  });
  // A file saved without those keys at all would let the JVM fall back to its own default port.
  for (const [key, value] of Object.entries(managed)) {
    if (!seen.has(key) && parsedHasKey(content, key)) continue;
    if (!seen.has(key)) {
      output.push(`${key}=${escapePropertyValue(value)}`);
      kept.push(key);
    }
  }
  return { content: output.join("\n"), kept };
}

function parsedHasKey(content: string, key: string): boolean {
  try {
    return key in parseProperties(content).values;
  } catch {
    return false;
  }
}

export function writeFile(serverId: number, path: string, content: string, expectedModifiedAt?: number): { size: number; modifiedAt: number; managedKeysKept: string[] } {
  const root = serverRoot(serverId);
  const target = resolveServerPath(root, path);
  // Writing server.properties through the raw editor keeps the allocation-owned keys intact.
  let managedKeysKept: string[] = [];
  if (basename(target).toLowerCase() === "server.properties") {
    const enforced = enforceManagedProperties(serverId, content);
    content = enforced.content;
    managedKeysKept = enforced.kept;
  }
  if (existsSync(target)) {
    const stat = statSync(target);
    if (stat.isDirectory()) throw new ApiException(400, "is_directory", "Path is a directory");
    // Optimistic concurrency: refuse to clobber a file changed by someone else.
    if (expectedModifiedAt && Math.abs(stat.mtimeMs - expectedModifiedAt) > 1000) {
      throw new ApiException(409, "file_changed", "This file changed on disk since you opened it. Reload to see the current contents.");
    }
  } else {
    mkdirSync(dirname(target), { recursive: true });
  }
  Bun.write(target, content);
  const stat = statSync(target);
  return { size: stat.size, modifiedAt: stat.mtimeMs, managedKeysKept };
}

export function createDirectory(serverId: number, path: string): void {
  const target = resolveServerPath(serverRoot(serverId), path);
  if (existsSync(target)) throw new ApiException(409, "exists", "A file or directory with that name already exists");
  mkdirSync(target, { recursive: true });
}

export function renameEntry(serverId: number, from: string, to: string): void {
  const root = serverRoot(serverId);
  const source = resolveServerPath(root, from, { mustExist: true });
  const destination = resolveServerPath(root, to);
  if (existsSync(destination)) throw new ApiException(409, "exists", "The destination already exists");
  mkdirSync(dirname(destination), { recursive: true });
  renameSync(source, destination);
}

export function copyEntry(serverId: number, from: string, to: string): void {
  const root = serverRoot(serverId);
  const source = resolveServerPath(root, from, { mustExist: true });
  const destination = resolveServerPath(root, to);
  if (existsSync(destination)) throw new ApiException(409, "exists", "The destination already exists");
  try {
    copyPath(source, destination);
  } catch (error) {
    if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
    throw new ApiException(500, "copy_failed", (error instanceof Error ? error.message : String(error)).slice(0, 300));
  }
}

export function deleteEntries(serverId: number, paths: string[], opts: { protectWorlds?: boolean } = {}): { deleted: string[] } {
  const root = serverRoot(serverId);
  const deleted: string[] = [];
  for (const path of paths) {
    const clean = sanitizeRelative(path);
    if (clean === "") throw new ApiException(400, "invalid_path", "Refusing to delete the server root");
    const target = resolveServerPath(root, clean, { mustExist: true });
    if (!isInside(root, target) || target === root) throw new ApiException(400, "invalid_path", "Refusing to delete this path");
    if (opts.protectWorlds && existsSync(join(target, "level.dat"))) {
      throw new ApiException(409, "protected_world", `${clean} looks like a world. Delete worlds from the Worlds page so RSLMC can protect your data.`);
    }
    rmSync(target, { recursive: true, force: true });
    deleted.push(clean);
  }
  return { deleted };
}

export async function saveUpload(serverId: number, path: string, file: File, opts: { overwrite?: boolean } = {}): Promise<{ path: string; size: number }> {
  if (file.size > MAX_UPLOAD_BYTES) throw new ApiException(413, "file_too_large", "Upload exceeds the 2 GB limit");
  const root = serverRoot(serverId);
  const target = resolveServerPath(root, path);
  if (existsSync(target) && !opts.overwrite) throw new ApiException(409, "exists", "A file with that name already exists");
  mkdirSync(dirname(target), { recursive: true });
  const temp = join(PATHS.temporary, `${randomUUID()}-upload`);
  await Bun.write(temp, file);
  renameSync(temp, target);
  return { path: sanitizeRelative(path), size: statSync(target).size };
}

/** Creates a downloadable tarball of a directory without loading it into memory. */
export function createArchive(serverId: number, path: string): { path: string; name: string } {
  const root = serverRoot(serverId);
  const target = resolveServerPath(root, path, { mustExist: true });
  const clean = sanitizeRelative(path);
  const name = `${clean === "" ? "server" : basename(clean)}-${Date.now()}.tar.gz`;
  const archive = join(PATHS.temporary, name);
  try {
    if (statSync(target).isDirectory()) {
      createTarGz(archive, { cwd: target, paths: ["."] });
    } else {
      createTarGz(archive, { cwd: dirname(target), paths: [basename(target)] });
    }
  } catch (error) {
    throw new ApiException(500, "archive_failed", (error instanceof Error ? error.message : String(error)).slice(0, 300));
  }
  return { path: archive, name };
}

/**
 * Extracts an uploaded archive after validating every entry path, so a crafted archive cannot
 * write outside the server directory (zip-slip protection).
 */
export function extractArchive(serverId: number, archivePath: string, destination = ""): { extracted: number } {
  const root = serverRoot(serverId);
  const target = resolveServerPath(root, destination);
  mkdirSync(target, { recursive: true });

  // Both extractors validate every entry path internally (zip-slip protection) and run in-process,
  // so no `tar`/`unzip` binary is required (they do not exist on Windows).
  const lower = archivePath.toLowerCase();
  try {
    if (lower.endsWith(".zip")) {
      const result = extractZip(archivePath, target);
      return { extracted: result.files };
    }
    const result = extractTarGz(archivePath, target);
    return { extracted: result.files };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unsafe path|absolute path|escapes the destination/i.test(message)) {
      throw new ApiException(400, "unsafe_archive", message.slice(0, 200));
    }
    if (/not a zip|corrupt|truncated|unsupported zip compression/i.test(message)) {
      throw new ApiException(400, "unsupported_archive", `Only .tar.gz and .zip archives are supported: ${message.slice(0, 160)}`);
    }
    throw new ApiException(500, "extract_failed", message.slice(0, 300));
  }
}

export function searchFiles(serverId: number, query: string, limit = 200): FileEntry[] {
  const root = serverRoot(serverId);
  const needle = query.toLowerCase();
  const out: FileEntry[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= limit || depth > 6) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (out.length >= limit) return;
      const full = join(dir, name);
      let stat;
      try { stat = statSync(full); } catch { continue; }
      if (name.toLowerCase().includes(needle)) {
        out.push({
          name,
          path: sanitizeRelative(full.slice(root.length + 1)),
          type: stat.isDirectory() ? "directory" : "file",
          size: stat.size,
          modifiedAt: stat.mtimeMs,
          mode: (stat.mode & 0o777).toString(8),
          editable: EDITABLE_EXTENSIONS.has(name.split(".").pop()?.toLowerCase() ?? ""),
        });
      }
      if (stat.isDirectory() && depth < 6) walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

export function fileStream(serverId: number, path: string): { stream: ReadableStream; size: number; name: string } {
  const root = serverRoot(serverId);
  const target = resolveServerPath(root, path, { mustExist: true });
  const stat = statSync(target);
  if (stat.isDirectory()) throw new ApiException(400, "is_directory", "Cannot download a directory — create an archive instead");
  const file = Bun.file(target);
  return { stream: file.stream(), size: stat.size, name: basename(target) };
}

export function diskUsageForServer(serverId: number): { bytes: number } {
  // Pure-JS walk instead of `du -sb`: the panel has to work on Windows too.
  try {
    return { bytes: directorySize(serverRoot(serverId)) };
  } catch {
    return { bytes: 0 };
  }
}

import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { badRequest } from "../shared/http";

/** Normalises a user-supplied relative path and rejects traversal / absolute escapes. */
export function sanitizeRelative(input: string): string {
  if (typeof input !== "string") throw badRequest("Path must be a string");
  const normalized = normalize(input.replace(/\\/g, "/")).replace(/^([/\\])+/, "");
  if (normalized.split("/").some((part) => part === "..")) throw badRequest("Path traversal is not allowed");
  if (normalized.includes("\0")) throw badRequest("Invalid path");
  return normalized === "." ? "" : normalized;
}

/** True when `child` is inside `parent` (after resolving both). */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolves a user path inside a server's data directory with symlink-escape protection.
 * The nearest existing ancestor is realpath-ed so a symlinked intermediate directory
 * cannot be used to break out of the sandbox.
 */
export function resolveServerPath(serverDir: string, userPath: string, opts: { mustExist?: boolean } = {}): string {
  const relativePath = sanitizeRelative(userPath);
  const baseReal = existsSync(serverDir) ? realpathSync(serverDir) : serverDir;
  const target = relativePath === "" ? baseReal : join(baseReal, relativePath);
  if (!isInside(baseReal, target)) throw badRequest("Path escapes the server directory");

  if (existsSync(target)) {
    const real = realpathSync(target);
    if (!isInside(baseReal, real)) throw badRequest("Path resolves outside the server directory");
    return real;
  }
  if (opts.mustExist) throw badRequest(`Path does not exist: ${relativePath || "/"}`);

  // Walk up to the closest existing ancestor and verify it is still inside the sandbox.
  let ancestor = target;
  while (ancestor !== baseReal && !existsSync(ancestor)) {
    const parent = join(ancestor, "..");
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (existsSync(ancestor)) {
    const realAncestor = realpathSync(ancestor);
    if (!isInside(baseReal, realAncestor)) throw badRequest("Path resolves outside the server directory");
    return join(realAncestor, relative(baseReal, ancestor) === "." ? "" : "", relative(ancestor, target)).replace(/\/+/g, sep);
  }
  return target;
}

export function isProbablyBinary(path: string, sampleSize = 8000): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return true;
    if (stat.size > 5 * 1024 * 1024) return true;
    const file = Bun.file(path);
    return file.size > 0 && /\.(jar|zip|gz|tar|png|jpg|jpeg|webp|ico|dat|mca|mcr|bin|db|nbt|ogg|mp3|woff2?)$/i.test(path);
  } catch {
    return true;
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, index);
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

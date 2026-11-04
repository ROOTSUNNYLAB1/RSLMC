import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { badRequest } from "../shared/http";

/** Normalises a user-supplied relative path and rejects traversal / absolute escapes. */
/**
 * Names Windows cannot represent as ordinary files: they are devices, so `NUL` opens the null device
 * and `CON` the console — the write silently goes somewhere else. Trailing dots and spaces are
 * silently stripped by Win32, which turns two different panel paths into the same file.
 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export function sanitizeRelative(input: string): string {
  if (typeof input !== "string") throw badRequest("Path must be a string");
  const normalized = normalize(input.replace(/\\/g, "/")).replace(/^([/\\])+/, "");
  const parts = normalized.split("/");
  if (parts.some((part) => part === "..")) throw badRequest("Path traversal is not allowed");
  if (normalized.includes("\0")) throw badRequest("Invalid path");
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (WINDOWS_RESERVED.test(part)) {
      throw badRequest(`“${part}” is a reserved device name on Windows and cannot be used as a file or folder name`);
    }
    if (/[. ]$/.test(part)) {
      throw badRequest(`“${part}” ends with a dot or a space, which Windows strips — rename it first`);
    }
  }
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

  /*
   * `existsSync` follows links, so a *dangling* symlink (`world/plugins -> /etc`) looked
   * non-existent: the write path then returned the link's own path and the following write went
   * wherever the link pointed. `lstat` sees the link itself, and a link is only usable when its
   * resolved target stays inside the sandbox.
   */
  const isLink = (candidate: string): boolean => {
    try { return lstatSync(candidate).isSymbolicLink(); } catch { return false; }
  };
  if (existsSync(target) || isLink(target)) {
    const real = existsSync(target) ? realpathSync(target) : null;
    if (real === null) throw badRequest(`Path is a broken symbolic link: ${relativePath}`);
    if (!isInside(baseReal, real)) throw badRequest("Path resolves outside the server directory");
    return real;
  }
  if (opts.mustExist) throw badRequest(`Path does not exist: ${relativePath || "/"}`);

  // Walk up to the closest existing ancestor and verify it is still inside the sandbox.
  let ancestor = target;
  while (ancestor !== baseReal && !existsSync(ancestor) && !isLink(ancestor)) {
    const parent = join(ancestor, "..");
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (isLink(ancestor) && !existsSync(ancestor)) {
    throw badRequest("Path contains a broken symbolic link, so RSLMC will not write through it");
  }
  if (existsSync(ancestor)) {
    const realAncestor = realpathSync(ancestor);
    if (!isInside(baseReal, realAncestor)) throw badRequest("Path resolves outside the server directory");
    return join(realAncestor, relative(baseReal, ancestor) === "." ? "" : "", relative(ancestor, target)).replace(/\/+/g, sep);
  }
  return target;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, index);
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

/**
 * Cross-platform filesystem helpers.
 *
 * These replace the shell commands the panel used to spawn (`mkdir`, `mv`, `cp`, `du`), which do
 * not exist on Windows. Everything here uses node:fs and behaves identically on Linux, macOS and
 * Windows.
 */
import {
  copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const IS_WINDOWS = process.platform === "win32";

/** `mkdir -p`. */
export function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

/** `mv`, including across devices/filesystems where a plain rename fails (EXDEV). */
export function movePath(source: string, destination: string): void {
  ensureDir(dirname(destination));
  try {
    renameSync(source, destination);
  } catch (error: any) {
    if (error?.code !== "EXDEV" && error?.code !== "EPERM") throw error;
    copyPath(source, destination);
    rmSync(source, { recursive: true, force: true });
  }
}

/** `cp -a`. */
export function copyPath(source: string, destination: string): void {
  ensureDir(dirname(destination));
  const stat = statSync(source);
  if (stat.isDirectory()) {
    cpSync(source, destination, { recursive: true, dereference: false, errorOnExist: false });
  } else {
    copyFileSync(source, destination);
  }
}

/**
 * Recursive directory size in bytes (`du -sb`), computed in-process.
 * Symlinks are counted as their own size rather than followed, so a link loop cannot hang us.
 */
export function directorySize(path: string): number {
  if (!existsSync(path)) return 0;
  let total = 0;
  const stack = [path];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      try {
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isSymbolicLink()) total += 0;
        else total += statSync(full).size;
      } catch {
        /* file vanished mid-walk */
      }
    }
  }
  return total;
}

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PATHS } from "../shared/config";
import { query, queryOne, run } from "../database";
import { ApiException, badRequest } from "../shared/http";

/**
 * Profile pictures.
 *
 * Deliberately small and dependency-free: the panel stores the uploaded file as-is (no image
 * re-encoding, so no native library and nothing to keep patched) after checking that the bytes
 * really are a PNG, JPEG or WebP — the magic number is checked, not the browser-supplied MIME type
 * or the file extension. Files live under `<data>/avatars/`, one per account, and are served by an
 * authenticated route with an ETag so the sidebar does not re-download them on every page.
 */

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_DIR = PATHS.avatars;

export type AvatarType = "image/png" | "image/jpeg" | "image/webp";

export interface AvatarRecord {
  file: string;
  version: number;
}

/** Exposed so tests and maintenance scripts can look at the same directory without hardcoding it. */
export function avatarDirectory(): string {
  return AVATAR_DIR;
}

function ensureDir(): void {
  mkdirSync(AVATAR_DIR, { recursive: true });
}

/** Identifies the image by its first bytes. Returns null for anything that is not one of the three. */
export function sniffImageType(bytes: Uint8Array): AvatarType | null {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46   // "RIFF"
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) { // "WEBP"
    return "image/webp";
  }
  return null;
}

const EXTENSION: Record<AvatarType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

const MIME_FOR_EXTENSION: Record<string, AvatarType> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
};

/** Width/height when it can be read from the header — used only for the honest size message. */
export function imageDimensions(bytes: Uint8Array, type: AvatarType): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (type === "image/png" && bytes.length >= 24) {
      return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (type === "image/webp" && bytes.length >= 30) {
      const chunk = String.fromCharCode(...bytes.slice(12, 16));
      if (chunk === "VP8X") {
        const w = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
        const h = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
        return { width: w, height: h };
      }
      if (chunk === "VP8 ") return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
      if (chunk === "VP8L") {
        const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      return null;
    }
    if (type === "image/jpeg") {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) { offset += 1; continue; }
        const marker = bytes[offset + 1]!;
        const length = view.getUint16(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
        }
        offset += 2 + length;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function avatarRecord(userId: number): AvatarRecord | null {
  const row = queryOne<{ avatar_file: string | null; avatar_version: number }>(
    "SELECT avatar_file, avatar_version FROM users WHERE id = ?", [userId],
  );
  if (!row?.avatar_file) return null;
  return { file: row.avatar_file, version: row.avatar_version ?? 0 };
}

/** The URL the UI should use. Bumping `?v=` is what makes a replaced picture appear immediately. */
export function avatarUrl(userId: number, record: AvatarRecord | null): string | null {
  return record ? `/api/users/${userId}/avatar?v=${record.version}` : null;
}

export function saveAvatar(userId: number, bytes: Uint8Array): { url: string; bytes: number; width: number | null; height: number | null } {
  if (bytes.length === 0) throw badRequest("The file is empty.");
  if (bytes.length > AVATAR_MAX_BYTES) {
    throw new ApiException(413, "avatar_too_large", `Profile pictures must be 2 MB or smaller (this one is ${(bytes.length / 1024 / 1024).toFixed(1)} MB).`);
  }
  const type = sniffImageType(bytes);
  if (!type) {
    throw badRequest("That file is not a PNG, JPEG or WebP image. (A `.png` file that is really something else will be refused too.)");
  }
  const dimensions = imageDimensions(bytes, type);
  // A picture cannot be taller/wider than 4096 in any sane case; this catches decompression-bomb
  // style headers without decoding anything.
  if (dimensions && (dimensions.width > 4096 || dimensions.height > 4096)) {
    throw badRequest(`Image is ${dimensions.width}×${dimensions.height} — please use something up to 4096×4096.`);
  }

  const existing = avatarRecord(userId);
  if (existing) removeAvatarFile(existing.file);

  ensureDir();
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 10);
  const file = `u${userId}-${digest}.${EXTENSION[type]}`;
  const target = join(AVATAR_DIR, file);
  // Staged beside the target and renamed: a half-written file can never become the live avatar,
  // and the rename is atomic on Linux, macOS and Windows (same directory, same volume).
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, bytes);
  renameSync(temporary, target);

  run("UPDATE users SET avatar_file = ?, avatar_version = avatar_version + 1 WHERE id = ?", [file, userId]);
  const record = avatarRecord(userId);
  return {
    url: avatarUrl(userId, record)!,
    bytes: bytes.length,
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
  };
}

function removeAvatarFile(file: string): void {
  // Only ever delete a basename inside the avatar directory — never a caller-supplied path.
  const name = file.split(/[\\/]/).pop() ?? "";
  if (!name || name.includes("..")) return;
  rmSync(join(AVATAR_DIR, name), { force: true });
}

export function deleteAvatar(userId: number): void {
  const existing = avatarRecord(userId);
  if (existing) removeAvatarFile(existing.file);
  run("UPDATE users SET avatar_file = NULL, avatar_version = avatar_version + 1 WHERE id = ?", [userId]);
}

export function readAvatar(userId: number): { bytes: Uint8Array; type: AvatarType; version: number } | null {
  const record = avatarRecord(userId);
  if (!record) return null;
  const name = record.file.split(/[\\/]/).pop() ?? "";
  if (!name || name.includes("..")) return null;
  const extension = name.split(".").pop() ?? "";
  const type = MIME_FOR_EXTENSION[extension];
  if (!type) return null;
  const path = join(AVATAR_DIR, name);
  if (!existsSync(path)) return null;
  return { bytes: new Uint8Array(readFileSync(path)), type, version: record.version };
}

/**
 * Leftover temp files and pictures whose account was deleted are cleaned at boot. Cheap: one
 * directory listing and one query.
 */
export function pruneOrphanAvatars(): { removed: number } {
  if (!existsSync(AVATAR_DIR)) return { removed: 0 };
  const referenced = new Set(
    query<{ avatar_file: string | null }>("SELECT avatar_file FROM users WHERE avatar_file IS NOT NULL")
      .map((row) => row.avatar_file)
      .filter((value): value is string => Boolean(value)),
  );
  let removed = 0;
  for (const entry of readdirSync(AVATAR_DIR)) {
    if (entry.endsWith(".tmp")) {
      rmSync(join(AVATAR_DIR, entry), { force: true });
      removed += 1;
      continue;
    }
    if (!referenced.has(entry)) {
      rmSync(join(AVATAR_DIR, entry), { force: true });
      removed += 1;
    }
  }
  return { removed };
}

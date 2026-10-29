import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";

/*
 * Profile pictures: what the upload accepts, what it must refuse, and what it leaves on disk. The
 * bytes below are real (tiny) images, not random data, because the whole point of the service is
 * that it trusts the magic number and nothing else.
 */
const DATA_DIR = mkdtempSync(join(tmpdir(), "rslmc-avatar-"));
process.env.RSLMC_DATA_DIR = DATA_DIR;

let avatars: typeof import("../src/services/avatars");
let bootstrap: typeof import("../src/services/bootstrap");
let db: typeof import("../src/database");

/** A 2×2 PNG assembled by hand (IHDR + one IDAT + IEND) with a correct CRC per chunk. */
function makePng(width = 2, height = 2): Uint8Array {
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (bytes: Uint8Array): number => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // truecolour
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let row = 0; row < height; row += 1) {
    raw[row * (1 + width * 3)] = 0; // filter: none
    for (let col = 0; col < width; col += 1) {
      const at = row * (1 + width * 3) + 1 + col * 3;
      raw[at] = 0x2f; raw[at + 1] = 0x6b; raw[at + 2] = 0x4a;
    }
  }
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [signature, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { png.set(part, offset); offset += part.length; }
  return png;
}

/** Minimal but structurally valid JPEG header: SOI + SOF0 with size + EOI. */
function makeJpeg(width = 4, height = 4): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,                                     // SOI
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
    0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,                                     // EOI
  ]);
}

function makeWebp(width = 8, height = 8): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);           // RIFF
  bytes.set([0x1a, 0x00, 0x00, 0x00], 4);           // size
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);           // WEBP
  bytes.set([0x56, 0x50, 0x38, 0x58], 12);          // VP8X
  bytes.set([0x0a, 0x00, 0x00, 0x00], 16);          // chunk size
  bytes[24] = (width - 1) & 0xff;
  bytes[25] = ((width - 1) >> 8) & 0xff;
  bytes[27] = (height - 1) & 0xff;
  bytes[28] = ((height - 1) >> 8) & 0xff;
  return bytes;
}

let userId = 0;
let otherId = 0;

beforeAll(async () => {
  bootstrap = await import("../src/services/bootstrap");
  avatars = await import("../src/services/avatars");
  db = await import("../src/database");
  await bootstrap.bootstrap();
  userId = db.insert("INSERT INTO users (username, email, password_hash, is_root, disabled, avatar_color) VALUES ('pic-user', 'pic@example.com', 'x', 0, 0, '#1f6f4a')");
  otherId = db.insert("INSERT INTO users (username, email, password_hash, is_root, disabled, avatar_color) VALUES ('other-user', 'other@example.com', 'x', 0, 0, '#2a5f8a')");
});

describe("format detection", () => {
  test("recognises PNG, JPEG and WebP by their magic bytes", () => {
    expect(avatars.sniffImageType(makePng())).toBe("image/png");
    expect(avatars.sniffImageType(makeJpeg())).toBe("image/jpeg");
    expect(avatars.sniffImageType(makeWebp())).toBe("image/webp");
  });

  test("refuses everything else, including a renamed file", () => {
    expect(avatars.sniffImageType(new TextEncoder().encode("<svg onload=alert(1)></svg>"))).toBeNull();
    expect(avatars.sniffImageType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBeNull(); // GIF
    expect(avatars.sniffImageType(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeNull();            // PDF
    expect(avatars.sniffImageType(new Uint8Array())).toBeNull();
  });

  test("reads the dimensions it advertises", () => {
    expect(avatars.imageDimensions(makePng(64, 48), "image/png")).toEqual({ width: 64, height: 48 });
    expect(avatars.imageDimensions(makeJpeg(120, 90), "image/jpeg")).toEqual({ width: 120, height: 90 });
    expect(avatars.imageDimensions(makeWebp(300, 200), "image/webp")).toEqual({ width: 300, height: 200 });
  });
});

describe("uploading", () => {
  test("stores the picture, bumps the version and returns a cache-busted URL", () => {
    const saved = avatars.saveAvatar(userId, makePng(64, 64));
    expect(saved.width).toBe(64);
    expect(saved.height).toBe(64);
    expect(saved.url).toBe(`/api/users/${userId}/avatar?v=1`);

    const read = avatars.readAvatar(userId)!;
    expect(read.type).toBe("image/png");
    expect(read.version).toBe(1);
    expect(read.bytes.length).toBe(makePng(64, 64).length);

    const again = avatars.saveAvatar(userId, makeJpeg(32, 32));
    expect(again.url).toBe(`/api/users/${userId}/avatar?v=2`);
    expect(avatars.readAvatar(userId)!.type).toBe("image/jpeg");
  });

  test("replacing a picture deletes the previous file instead of piling up", () => {
    avatars.saveAvatar(userId, makePng(10, 10));
    const first = avatars.avatarRecord(userId)!;
    avatars.saveAvatar(userId, makePng(11, 11));
    const second = avatars.avatarRecord(userId)!;
    expect(second.file).not.toBe(first.file);
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const files = readdirSync(avatars.avatarDirectory()) as string[];
    expect(files.filter((name) => name.startsWith(`u${userId}-`)).length).toBe(1);
  });

  test("two accounts never share a file and cannot read each other's pictures", () => {
    expect(avatars.readAvatar(otherId)).toBeNull();
    avatars.saveAvatar(otherId, makeWebp(24, 24));
    expect(avatars.readAvatar(otherId)!.type).toBe("image/webp");
    expect(avatars.avatarRecord(otherId)!.file).not.toBe(avatars.avatarRecord(userId)!.file);
  });

  test("an oversized file is refused with the real numbers", () => {
    const huge = new Uint8Array(avatars.AVATAR_MAX_BYTES + 1);
    huge.set(makePng().subarray(0, 8), 0);
    expect(() => avatars.saveAvatar(userId, huge)).toThrow(/2 MB/);
  });

  test("a file that only claims to be an image is refused", () => {
    expect(() => avatars.saveAvatar(userId, new TextEncoder().encode("<?php system($_GET[0]); ?>"))).toThrow(/PNG, JPEG or WebP/);
    expect(() => avatars.saveAvatar(userId, new Uint8Array())).toThrow(/empty/i);
  });

  test("an absurd resolution is refused before anything is stored", () => {
    const png = makePng(9000, 9000);
    expect(() => avatars.saveAvatar(userId, png)).toThrow(/4096/);
  });

  test("removing restores the initials avatar", () => {
    avatars.saveAvatar(userId, makePng());
    avatars.deleteAvatar(userId);
    expect(avatars.avatarRecord(userId)).toBeNull();
    expect(avatars.readAvatar(userId)).toBeNull();
  });
});

describe("housekeeping", () => {
  test("orphaned files and temp files are cleaned, live ones are kept", () => {
    avatars.saveAvatar(userId, makePng());
    avatars.saveAvatar(otherId, makePng(3, 3));
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    const dir = avatars.avatarDirectory();
    writeFileSync(join(dir, "u999-deadbeef.png"), makePng());
    writeFileSync(join(dir, `u${userId}-half.png.1234.tmp`), "partial");

    const result = avatars.pruneOrphanAvatars();
    expect(result.removed).toBe(2);
    expect(avatars.readAvatar(userId)).not.toBeNull();
    expect(avatars.readAvatar(otherId)).not.toBeNull();
  });
});

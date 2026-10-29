/**
 * Dependency-free tar.gz / zip support.
 *
 * RSLMC used to shell out to `tar`, `unzip`, `mkdir`, `mv` and `du`. Those binaries do not exist
 * on Windows, which broke Java installation and backups on a normal Windows host. Everything here
 * is implemented in TypeScript (via node:zlib) so the same code runs on Linux, macOS and Windows
 * with no external tools and no PATH assumptions.
 *
 * Safety: every extracted entry is normalised and rejected if it is absolute or escapes the
 * destination ("zip-slip"), and symlink/hardlink entries are skipped rather than followed.
 */
import { gzipSync, gunzipSync, inflateRawSync } from "node:zlib";
import {
  chmodSync, closeSync, existsSync, mkdirSync, openSync, readSync, readFileSync, readdirSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { tmpdir } from "node:os";

const BLOCK = 512;

/*
 * Extraction budget.
 *
 * A .tar.gz is a compression bomb waiting to happen: a few hundred kilobytes can expand to hundreds
 * of gigabytes, and extraction used to write until the disk was full — which takes the panel down,
 * not just the server being extracted. Both readers now share one budget that is checked before each
 * write, and the error names the limit so an operator knows what happened.
 *
 * RSLMC_EXTRACT_MAX_MB raises the ceiling for people who really do unpack an enormous world.
 */
const EXTRACT_MAX_BYTES = Math.max(
  64,
  Number(process.env.RSLMC_EXTRACT_MAX_MB ?? 4096),
) * 1024 * 1024;
const EXTRACT_MAX_ENTRIES = 200_000;

class ExtractBudget {
  private bytes = 0;
  private entries = 0;
  spend(size: number, entry: string): void {
    this.bytes += size;
    this.entries += 1;
    if (this.bytes > EXTRACT_MAX_BYTES) {
      throw new Error(
        `Archive expands beyond the ${Math.round(EXTRACT_MAX_BYTES / 1024 / 1024)} MB extraction limit `
        + `(stopped at ${entry.slice(0, 80)}). Set RSLMC_EXTRACT_MAX_MB to raise it.`,
      );
    }
    if (this.entries > EXTRACT_MAX_ENTRIES) {
      throw new Error(`Archive contains more than ${EXTRACT_MAX_ENTRIES} entries — refusing to extract it.`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Path safety                                                         */
/* ------------------------------------------------------------------ */

/** Normalises an archive entry name and rejects anything that could escape the destination. */
export function safeArchiveEntry(entry: string): string {
  const unified = entry.replace(/\\/g, "/").replace(/\0.*$/, "");
  if (!unified || unified === ".") return "";
  if (unified.startsWith("/") || /^[a-zA-Z]:/.test(unified)) {
    throw new Error(`Archive contains an absolute path: ${unified.slice(0, 120)}`);
  }
  const parts = unified.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === "..")) {
    throw new Error(`Archive contains an unsafe path: ${unified.slice(0, 120)}`);
  }
  return parts.join("/");
}

function resolveInside(root: string, entry: string): string {
  const clean = safeArchiveEntry(entry);
  const full = normalize(join(root, clean));
  const normalizedRoot = normalize(root);
  if (full !== normalizedRoot && !full.startsWith(normalizedRoot + sep)) {
    throw new Error(`Archive entry escapes the destination: ${entry.slice(0, 120)}`);
  }
  return full;
}

/* ------------------------------------------------------------------ */
/* tar (ustar) writer                                                  */
/* ------------------------------------------------------------------ */

interface TarEntry {
  /** Path inside the archive, always POSIX style. */
  name: string;
  /** Absolute source path. */
  source: string;
  kind: "file" | "directory";
}

function octal(value: number, length: number): Buffer {
  const text = Math.max(0, Math.floor(value)).toString(8);
  return Buffer.from(text.padStart(length - 1, "0") + "\0", "ascii");
}

function writeString(target: Buffer, offset: number, length: number, value: string): void {
  target.write(value.slice(0, length), offset, "utf8");
}

function header(entry: TarEntry, size: number, mtime: number): Buffer {
  const buffer = Buffer.alloc(BLOCK, 0);
  let name = entry.name;
  let prefix = "";

  if (Buffer.byteLength(name) > 100) {
    // ustar splits long paths into prefix + name at a "/" boundary.
    const splitAt = name.lastIndexOf("/", 155);
    if (splitAt > 0 && Buffer.byteLength(name.slice(splitAt + 1)) <= 100) {
      prefix = name.slice(0, splitAt);
      name = name.slice(splitAt + 1);
    }
  }

  writeString(buffer, 0, 100, name);
  buffer.write("0000755\0", 100, "ascii");           // mode
  buffer.write("0000000\0", 108, "ascii");           // uid
  buffer.write("0000000\0", 116, "ascii");           // gid
  octal(size, 12).copy(buffer, 124);
  octal(Math.floor(mtime / 1000), 12).copy(buffer, 136);
  buffer.write(entry.kind === "directory" ? "5" : "0", 156, "ascii");
  buffer.write("ustar\0", 257, "ascii");
  buffer.write("00", 263, "ascii");
  writeString(buffer, 265, 32, "rslmc");
  writeString(buffer, 297, 32, "rslmc");
  octal(0, 8).copy(buffer, 329);
  octal(0, 8).copy(buffer, 337);
  writeString(buffer, 345, 155, prefix);

  // Checksum: field is spaces while the sum is computed, then written as 6 octal digits + NUL + space.
  buffer.write("        ", 148, "ascii");
  let sum = 0;
  for (const byte of buffer) sum += byte;
  buffer.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return buffer;
}

function collect(root: string, relative = ""): TarEntry[] {
  const entries: TarEntry[] = [];
  const current = relative ? join(root, relative) : root;
  for (const dirent of readdirSync(current, { withFileTypes: true })) {
    const rel = relative ? `${relative}/${dirent.name}` : dirent.name;
    const absolute = join(root, rel);
    // Never follow symlinks: archiving them would either duplicate data or leak outside targets.
    if (dirent.isSymbolicLink()) continue;
    if (dirent.isDirectory()) {
      entries.push({ name: `${rel}/`, source: absolute, kind: "directory" });
      entries.push(...collect(root, rel));
    } else if (dirent.isFile()) {
      entries.push({ name: rel, source: absolute, kind: "file" });
    }
  }
  return entries;
}

export interface CreateArchiveOptions {
  /** Directory the relative paths are resolved against. */
  cwd: string;
  /** Relative files/directories to include; `"."` (default) means the whole directory. */
  paths?: string[];
  /** Directory names to skip at any depth (e.g. `.rslmc-tmp`). */
  exclude?: string[];
  /** Called with (processedFiles, totalFiles) so callers can stream progress. */
  onProgress?: (done: number, total: number) => void;
}

/** Creates a gzip-compressed tar archive and returns the number of files written. */
export function createTarGz(archivePath: string, options: CreateArchiveOptions): { files: number; bytes: number } {
  const exclude = new Set((options.exclude ?? []).map((entry) => entry.replace(/^\.\//, "").replace(/\/$/, "")));
  const wanted = options.paths && options.paths.length > 0 ? options.paths : ["."];

  const entries: TarEntry[] = [];
  for (const path of wanted) {
    const clean = path.replace(/^\.\/?/, "");
    const absolute = clean === "" ? options.cwd : join(options.cwd, clean);
    let stat;
    try { stat = statSync(absolute); } catch { continue; }
    if (stat.isDirectory()) {
      const base = clean === "" ? "" : clean;
      entries.push({ name: base ? `${base}/` : "./", source: absolute, kind: "directory" });
      for (const entry of collect(absolute, "")) {
        const rel = base ? `${base}/${entry.name}` : entry.name;
        if (exclude.size > 0 && rel.split("/").some((part) => exclude.has(part))) continue;
        entries.push({ ...entry, name: rel });
      }
    } else if (stat.isFile()) {
      entries.push({ name: clean || "file", source: absolute, kind: "file" });
    }
  }

  const chunks: Buffer[] = [];
  let files = 0;
  const total = entries.filter((entry) => entry.kind === "file").length;
  for (const entry of entries) {
    if (entry.kind === "directory") {
      chunks.push(header(entry, 0, Date.now()));
      continue;
    }
    const data = readFileSync(entry.source);
    chunks.push(header(entry, data.length, statSync(entry.source).mtimeMs));
    chunks.push(data);
    const padding = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (padding > 0) chunks.push(Buffer.alloc(padding, 0));
    files += 1;
    options.onProgress?.(files, total);
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0));

  const gz = gzipSync(Buffer.concat(chunks), { level: 6 });
  mkdirSync(dirname(archivePath), { recursive: true });
  writeFileSync(archivePath, gz);
  return { files, bytes: gz.length };
}

/* ------------------------------------------------------------------ */
/* tar reader                                                          */
/* ------------------------------------------------------------------ */

function readOctal(buffer: Buffer, offset: number, length: number): number {
  const slice = buffer.subarray(offset, offset + length);
  // GNU tar writes base-256 for very large values: high bit of the first byte is set.
  if (slice[0] & 0x80) {
    let value = 0;
    for (const byte of slice) value = value * 256 + byte;
    return value - Math.pow(2, slice.length * 8);
  }
  const text = slice.toString("ascii").replace(/\0.*$/, "").trim();
  if (!text) return 0;
  const parsed = parseInt(text, 8);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isZeroBlock(buffer: Buffer): boolean {
  for (const byte of buffer) if (byte !== 0) return false;
  return true;
}

function readPaxPath(data: Buffer): string | null {
  const text = data.toString("utf8");
  const match = /(?:^|\n)\d+ path=([^\n]+)/.exec(text);
  return match ? match[1]! : null;
}

export interface ExtractResult {
  files: number;
  directories: number;
  entries: string[];
}

/**
 * Restores the POSIX permission bits recorded in an archive entry.
 * Without this, executables (JDK `bin/java`, shell scripts) come out as 0644 and
 * spawning them fails with EACCES. On Windows chmod only toggles the read-only
 * flag, so a failure there is harmless and ignored.
 */
function applyMode(target: string, rawMode: number): void {
  const mode = rawMode & 0o777;
  if (!mode) return;
  try { chmodSync(target, mode); } catch { /* unsupported on this filesystem */ }
}

/** Extracts a .tar / .tar.gz archive into `destination` (created if missing). */
export function extractTarGz(archivePath: string, destination: string): ExtractResult {
  const raw = readFileSync(archivePath);
  // Gzip magic keeps us from guessing wrong when a plain .tar is passed.
  const buffer = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;

  mkdirSync(destination, { recursive: true });
  const result: ExtractResult = { files: 0, directories: 0, entries: [] };
  const budget = new ExtractBudget();
  let offset = 0;
  let longName: string | null = null;
  let pendingPaxPath: string | null = null;

  while (offset + BLOCK <= buffer.length) {
    const block = buffer.subarray(offset, offset + BLOCK);
    if (isZeroBlock(block)) break;

    const size = readOctal(block, 124, 12);
    const type = String.fromCharCode(block[156] ?? 0);
    const prefix = block.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const baseName = block.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) throw new Error("Archive is truncated or corrupt");
    const data = buffer.subarray(dataStart, dataEnd);

    // Metadata entries: GNU long name ('L') and pax extended headers ('x').
    if (type === "L") {
      longName = data.toString("utf8").replace(/\0.*$/, "");
      offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
      continue;
    }
    if (type === "x") {
      pendingPaxPath = readPaxPath(data) ?? pendingPaxPath;
      offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
      continue;
    }
    if (type === "g") {
      offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
      continue;
    }

    const rawName = longName ?? pendingPaxPath ?? (prefix ? `${prefix}/${baseName}` : baseName);
    longName = null;
    pendingPaxPath = null;

    if (type === "5") {
      const dir = resolveInside(destination, rawName);
      mkdirSync(dir, { recursive: true });
      applyMode(dir, readOctal(block, 100, 8));
      result.directories += 1;
    } else if (type === "0" || type === "" || type === "\0" || type === "7") {
      // Symlinks ('2'), hardlinks ('1') and devices are intentionally skipped (see header docs).
      const target = resolveInside(destination, rawName);
      budget.spend(size, rawName);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data);
      applyMode(target, readOctal(block, 100, 8));
      result.files += 1;
      result.entries.push(safeArchiveEntry(rawName));
    }

    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* zip reader                                                          */
/* ------------------------------------------------------------------ */

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 66_000);
  for (let index = buffer.length - 22; index >= minimum; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x0605_4b50) return index;
  }
  throw new Error("Not a zip archive (no end-of-central-directory record)");
}

/** Extracts a .zip archive (stored or deflated entries) into `destination`. */
export function extractZip(archivePath: string, destination: string): ExtractResult {
  const buffer = readFileSync(archivePath);
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);

  mkdirSync(destination, { recursive: true });
  const result: ExtractResult = { files: 0, directories: 0, entries: [] };
  const budget = new ExtractBudget();

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x0201_4b50) throw new Error("Corrupt zip central directory");
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    // Upper 16 bits of the external attributes hold the unix mode when the archive
    // was produced on a POSIX system (zip -X, Info-ZIP, GitHub Actions artefacts).
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;

    if (compressedSize === 0xffff_ffff || localOffset === 0xffff_ffff) {
      throw new Error("Zip64 archives are not supported — re-upload as .tar.gz");
    }

    const entryMode = (externalAttributes >>> 16) & 0o777;
    const isDirectory = name.endsWith("/");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);

    if (isDirectory) {
      const dir = resolveInside(destination, name);
      mkdirSync(dir, { recursive: true });
      applyMode(dir, entryMode);
      result.directories += 1;
      continue;
    }
    const target = resolveInside(destination, name);
    // Charge the budget with the *uncompressed* size before inflating, so a bomb is stopped before
    // the memory blow-up rather than after it.
    budget.spend(Math.max(uncompressedSize, compressedSize), name);
    mkdirSync(dirname(target), { recursive: true });

    if (method === 0) {
      writeFileSync(target, compressed);
    } else if (method === 8) {
      const inflated = inflateRawSync(compressed);
      if (uncompressedSize !== 0 && inflated.length !== uncompressedSize) {
        throw new Error(`Corrupt zip entry (size mismatch): ${name.slice(0, 120)}`);
      }
      writeFileSync(target, inflated);
    } else {
      throw new Error(`Unsupported zip compression method ${method} for ${name.slice(0, 120)}`);
    }
    applyMode(target, entryMode);
    result.files += 1;
    result.entries.push(safeArchiveEntry(name));
  }

  return result;
}



/**
 * Copies an exact byte range of a file to a new file.
 *
 * `Bun.write(path, bunFile.slice(a, b))` must not be used here: Bun optimises it into a
 * `copy_file_range` of the *whole* source file and ignores the slice bounds, which silently
 * writes the entire archive for every stored entry.
 */
const BULK_COPY_LIMIT = 8 * 1024 * 1024;
const COPY_CHUNK = 4 * 1024 * 1024;

async function writeSlice(file: Bun.BunFile, start: number, end: number, target: string): Promise<void> {
  const length = Math.max(0, end - start);
  if (length <= BULK_COPY_LIMIT) {
    await Bun.write(target, Buffer.from(await file.slice(start, end).arrayBuffer()));
    return;
  }
  const writer = Bun.file(target).writer();
  try {
    for (let offset = start; offset < end; offset += COPY_CHUNK) {
      const chunk = Buffer.from(await file.slice(offset, Math.min(end, offset + COPY_CHUNK)).arrayBuffer());
      writer.write(chunk);
      await writer.flush();
    }
  } finally {
    await writer.end();
  }
}

/**
 * Incremental reader over a decompressed stream: hands out exact byte counts without ever
 * holding more than one chunk plus leftovers in memory.
 */
class ChunkReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer: Buffer = Buffer.alloc(0);
  private ended = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  async readExact(length: number): Promise<Buffer | null> {
    while (this.buffer.length < length && !this.ended) {
      const { value, done } = await this.reader.read();
      if (done) { this.ended = true; break; }
      if (value && value.length > 0) {
        this.buffer = this.buffer.length === 0 ? Buffer.from(value) : Buffer.concat([this.buffer, Buffer.from(value)]);
      }
    }
    if (this.buffer.length < length) return null;
    const out = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return out;
  }

  /** Writes exactly `length` bytes from the stream to `target`, streaming through a 64 KB buffer. */
  async writeTo(target: string, length: number): Promise<boolean> {
    const handle = Bun.file(target).writer();
    let remaining = length;
    try {
      while (remaining > 0) {
        const chunkSize = Math.min(COPY_CHUNK, remaining);
        const chunk = await this.readExact(chunkSize);
        if (!chunk) { await handle.end(); return false; }
        handle.write(chunk);
        remaining -= chunkSize;
      }
      await handle.flush();
    } finally {
      await Promise.resolve(handle.end()).catch(() => {});
    }
    return true;
  }

  async skip(length: number): Promise<boolean> {
    let remaining = length;
    while (remaining > 0) {
      const chunk = await this.readExact(Math.min(COPY_CHUNK, remaining));
      if (!chunk) return false;
      remaining -= chunk.length;
    }
    return true;
  }

  async cancel(): Promise<void> {
    await this.reader.cancel().catch(() => {});
  }
}

/**
 * Streaming .tar.gz extraction (used for Eclipse Temurin on Linux).
 *
 * The buffered `extractTarGz` holds the compressed archive *and* the fully inflated tar in memory
 * (~500 MB for a JDK), which is enough to get a 2 GB panel host OOM-killed mid-install. Here the
 * gzip stream is decompressed on the fly and each entry is written straight to disk.
 */
export async function extractTarGzStreaming(archivePath: string, destination: string): Promise<ExtractResult> {
  const raw = Bun.file(archivePath);
  const head = Buffer.from(await raw.slice(0, 2).arrayBuffer());
  const isGzip = head[0] === 0x1f && head[1] === 0x8b;
  // A plain .tar has no gzip wrapper: feed the file stream straight into the parser.
  const stream: ReadableStream<Uint8Array> = isGzip
    ? raw.stream().pipeThrough(new DecompressionStream("gzip"))
    : raw.stream();

  const reader = new ChunkReader(stream);
  mkdirSync(destination, { recursive: true });
  const result: ExtractResult = { files: 0, directories: 0, entries: [] };
  let longName: string | null = null;
  let pendingPaxPath: string | null = null;

  try {
    for (;;) {
      const block = await reader.readExact(BLOCK);
      if (!block) break;
      if (isZeroBlock(block)) break;

      const size = readOctal(block, 124, 12);
      const type = String.fromCharCode(block[156] ?? 0);
      const prefix = block.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
      const baseName = block.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
      const paddedSize = Math.ceil(size / BLOCK) * BLOCK;

      if (type === "L") {
        const data = await reader.readExact(paddedSize);
        if (!data) break;
        longName = data.subarray(0, size).toString("utf8").replace(/\0.*$/, "");
        continue;
      }
      if (type === "x") {
        const data = await reader.readExact(paddedSize);
        if (!data) break;
        pendingPaxPath = readPaxPath(data.subarray(0, size)) ?? pendingPaxPath;
        continue;
      }
      if (type === "g") {
        if (!(await reader.skip(paddedSize))) break;
        continue;
      }

      const rawName = longName ?? pendingPaxPath ?? (prefix ? `${prefix}/${baseName}` : baseName);
      longName = null;
      pendingPaxPath = null;

      if (type === "5") {
        const dir = resolveInside(destination, rawName);
        mkdirSync(dir, { recursive: true });
        applyMode(dir, readOctal(block, 100, 8));
        result.directories += 1;
        if (!(await reader.skip(paddedSize))) break;
        continue;
      }

      if (type === "0" || type === "" || type === "\0" || type === "7") {
        const target = resolveInside(destination, rawName);
        mkdirSync(dirname(target), { recursive: true });
        const written = await reader.writeTo(target, size);
        if (!written) throw new Error(`Archive ended while writing ${rawName.slice(0, 120)}`);
        applyMode(target, readOctal(block, 100, 8));
        result.files += 1;
        result.entries.push(safeArchiveEntry(rawName));
        if (!(await reader.skip(paddedSize - size))) break;
        continue;
      }

      // Links: recreate them on POSIX so a JDK keeps its `lib/*.so` aliases; on Windows,
      // creating symlinks needs privileges, so they are skipped (Windows JDKs ship none).
      if ((type === "2" || type === "1") && process.platform !== "win32") {
        const linkName = size > 0
          ? (await reader.readExact(paddedSize))?.subarray(0, size).toString("utf8").replace(/\0.*$/, "")
          : block.subarray(157, 257).toString("utf8").replace(/\0.*$/, "");
        const target = resolveInside(destination, rawName);
        if (linkName && !linkName.startsWith("/")) {
          mkdirSync(dirname(target), { recursive: true });
          try {
            if (existsSync(target)) rmSync(target, { force: true });
            symlinkSync(linkName, target);
            result.files += 1;
            result.entries.push(safeArchiveEntry(rawName));
            continue;
          } catch { /* fall through: an unusable link is not worth failing the install */ }
        }
        if (size > 0 && !(await reader.skip(paddedSize))) break;
        continue;
      }

      // Devices, fifos and other special entries are skipped on purpose.
      if (!(await reader.skip(paddedSize))) break;
    }
  } finally {
    await reader.cancel();
  }

  return result;
}

/**
 * Streaming zip extraction.
 *
 * The buffered `extractZip` above is fine for small uploads, but a JDK archive is ~200 MB
 * compressed and ~350 MB inflated: reading it whole (then inflating each entry into a fresh
 * buffer) can push a small panel host into the OOM killer. This version only ever holds one
 * compressed chunk at a time and streams the inflated bytes straight to disk.
 */
export async function extractZipStreaming(archivePath: string, destination: string): Promise<ExtractResult> {
  const file = Bun.file(archivePath);
  const size = file.size;
  if (size < 22) throw new Error("Not a zip archive (file too small)");

  const tailLength = Math.min(size, 66_000);
  const tailStart = size - tailLength;
  const tail = Buffer.from(await file.slice(tailStart).arrayBuffer());

  let eocd = -1;
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === 0x0605_4b50) { eocd = index; break; }
  }
  if (eocd === -1) throw new Error("Not a zip archive (no end-of-central-directory record)");

  const entryCount = tail.readUInt16LE(eocd + 10);
  const centralSize = tail.readUInt32LE(eocd + 12);
  const centralOffset = tail.readUInt32LE(eocd + 16);
  if (centralOffset === 0xffff_ffff || centralSize === 0xffff_ffff) {
    throw new Error("Zip64 archives are not supported — re-upload as .tar.gz");
  }

  const central = Buffer.from(await file.slice(centralOffset, centralOffset + centralSize).arrayBuffer());
  mkdirSync(destination, { recursive: true });
  const result: ExtractResult = { files: 0, directories: 0, entries: [] };
  let cursor = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (central.readUInt32LE(cursor) !== 0x0201_4b50) throw new Error("Corrupt zip central directory");
    const method = central.readUInt16LE(cursor + 10);
    const compressedSize = central.readUInt32LE(cursor + 20);
    const nameLength = central.readUInt16LE(cursor + 28);
    const extraLength = central.readUInt16LE(cursor + 30);
    const commentLength = central.readUInt16LE(cursor + 32);
    const externalAttributes = central.readUInt32LE(cursor + 38);
    const localOffset = central.readUInt32LE(cursor + 42);
    const name = central.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;

    const entryMode = (externalAttributes >>> 16) & 0o777;
    if (name.endsWith("/")) {
      const dir = resolveInside(destination, name);
      mkdirSync(dir, { recursive: true });
      applyMode(dir, entryMode);
      result.directories += 1;
      continue;
    }

    const header = Buffer.from(await file.slice(localOffset, localOffset + 30).arrayBuffer());
    if (header.readUInt32LE(0) !== 0x0403_4b50) throw new Error(`Corrupt zip entry header: ${name.slice(0, 120)}`);
    const localNameLength = header.readUInt16LE(26);
    const localExtraLength = header.readUInt16LE(28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const target = resolveInside(destination, name);
    mkdirSync(dirname(target), { recursive: true });

    const compressed = file.slice(dataStart, dataStart + compressedSize);
    if (method === 0) {
      await writeSlice(file, dataStart, dataStart + compressedSize, target);
    } else if (method === 8) {
      const inflated = compressed.stream().pipeThrough(new DecompressionStream("deflate-raw"));
      await Bun.write(target, new Response(inflated));
    } else {
      throw new Error(`Unsupported zip compression method ${method} for ${name.slice(0, 120)}`);
    }
    applyMode(target, entryMode);
    result.files += 1;
    result.entries.push(safeArchiveEntry(name));
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* Detection helpers                                                   */
/* ------------------------------------------------------------------ */

/** Lists entry names without extracting (used for integrity checks). */
export function listArchive(archivePath: string): string[] {
  const header = Buffer.alloc(4);
  const fd = openSync(archivePath, "r");
  try { readSync(fd, header, 0, 4, 0); } finally { closeSync(fd); }

  const isZip = header[0] === 0x50 && header[1] === 0x4b;
  if (isZip) {
    const probe = join(tmpdir(), `rslmc-list-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    try {
      return extractZip(archivePath, probe).entries;
    } finally {
      try { rmSync(probe, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  const raw = readFileSync(archivePath);
  const buffer = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
  const names: string[] = [];
  let offset = 0;
  let longName: string | null = null;
  while (offset + BLOCK <= buffer.length) {
    const block = buffer.subarray(offset, offset + BLOCK);
    if (isZeroBlock(block)) break;
    const size = readOctal(block, 124, 12);
    const type = String.fromCharCode(block[156] ?? 0);
    const prefix = block.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const baseName = block.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const dataStart = offset + BLOCK;
    if (type === "L") {
      longName = buffer.subarray(dataStart, dataStart + size).toString("utf8").replace(/\0.*$/, "");
    } else if (type !== "x" && type !== "g") {
      names.push(longName ?? (prefix ? `${prefix}/${baseName}` : baseName));
      longName = null;
    }
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }
  return names;
}

/** True when the file parses as a tar(.gz) or zip archive. */
export function isReadableArchive(archivePath: string): boolean {
  try {
    listArchive(archivePath);
    return true;
  } catch {
    return false;
  }
}

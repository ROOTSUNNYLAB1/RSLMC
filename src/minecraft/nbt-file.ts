import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * Full NBT reader/writer used for player data (`world/playerdata/<uuid>.dat`).
 *
 * The read-only parser in `nbt.ts` is enough for level.dat metadata, but editing a player file
 * needs two things it does not provide: a writer, and lossless 64-bit integers (UUIDMost/Least
 * and world seeds do not survive a trip through a JS number). Longs are therefore kept as
 * `bigint` here, and every tag type is round-tripped unchanged — unknown/new fields in the file
 * are preserved instead of being dropped.
 */
export type Tag =
  | { t: 1; v: number }   // byte
  | { t: 2; v: number }   // short
  | { t: 3; v: number }   // int
  | { t: 4; v: bigint }   // long
  | { t: 5; v: number }   // float
  | { t: 6; v: number }   // double
  | { t: 7; v: Int8Array } // byte array
  | { t: 8; v: string }   // string
  | { t: 9; items: Tag[] } // list
  | { t: 10; v: Record<string, Tag> } // compound
  | { t: 11; v: Int32Array } // int array
  | { t: 12; v: BigInt64Array }; // long array

export type Compound = Record<string, Tag>;

class Reader {
  offset = 0;
  constructor(private buffer: Buffer) {}

  i8(): number { const v = this.buffer.readInt8(this.offset); this.offset += 1; return v; }
  u8(): number { const v = this.buffer.readUInt8(this.offset); this.offset += 1; return v; }
  i16(): number { const v = this.buffer.readInt16BE(this.offset); this.offset += 2; return v; }
  u16(): number { const v = this.buffer.readUInt16BE(this.offset); this.offset += 2; return v; }
  i32(): number { const v = this.buffer.readInt32BE(this.offset); this.offset += 4; return v; }
  i64(): bigint { const v = this.buffer.readBigInt64BE(this.offset); this.offset += 8; return v; }
  f32(): number { const v = this.buffer.readFloatBE(this.offset); this.offset += 4; return v; }
  f64(): number { const v = this.buffer.readDoubleBE(this.offset); this.offset += 8; return v; }

  str(): string {
    const length = this.u16();
    const value = this.buffer.toString("utf8", this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  payload(type: number): Tag {
    switch (type) {
      case 1: return { t: 1, v: this.i8() };
      case 2: return { t: 2, v: this.i16() };
      case 3: return { t: 3, v: this.i32() };
      case 4: return { t: 4, v: this.i64() };
      case 5: return { t: 5, v: this.f32() };
      case 6: return { t: 6, v: this.f64() };
      case 7: {
        const length = this.i32();
        const bytes = new Int8Array(length);
        for (let i = 0; i < length; i += 1) bytes[i] = this.i8();
        return { t: 7, v: bytes };
      }
      case 8: return { t: 8, v: this.str() };
      case 9: {
        const elementType = this.u8();
        const length = this.i32();
        const items: Tag[] = [];
        for (let i = 0; i < length; i += 1) items.push(this.payload(elementType));
        return { t: 9, items };
      }
      case 10: {
        const value: Compound = {};
        for (;;) {
          const childType = this.u8();
          if (childType === 0) break;
          const name = this.str();
          value[name] = this.payload(childType);
        }
        return { t: 10, v: value };
      }
      case 11: {
        const length = this.i32();
        const value = new Int32Array(length);
        for (let i = 0; i < length; i += 1) value[i] = this.i32();
        return { t: 11, v: value };
      }
      case 12: {
        const length = this.i32();
        const value = new BigInt64Array(length);
        for (let i = 0; i < length; i += 1) value[i] = this.i64();
        return { t: 12, v: value };
      }
      default:
        throw new Error(`Unknown NBT tag type ${type}`);
    }
  }
}

class Writer {
  private chunks: Buffer[] = [];

  private bytes(buffer: Buffer): void { this.chunks.push(buffer); }
  i8(value: number): void { this.bytes(Buffer.from([value & 0xff])); }
  u8(value: number): void { this.bytes(Buffer.from([value & 0xff])); }
  i16(value: number): void { const b = Buffer.alloc(2); b.writeInt16BE(value); this.bytes(b); }
  u16(value: number): void { const b = Buffer.alloc(2); b.writeUInt16BE(value); this.bytes(b); }
  i32(value: number): void { const b = Buffer.alloc(4); b.writeInt32BE(value); this.bytes(b); }
  i64(value: bigint): void { const b = Buffer.alloc(8); b.writeBigInt64BE(value); this.bytes(b); }
  f32(value: number): void { const b = Buffer.alloc(4); b.writeFloatBE(value); this.bytes(b); }
  f64(value: number): void { const b = Buffer.alloc(8); b.writeDoubleBE(value); this.bytes(b); }

  str(value: string): void {
    const encoded = Buffer.from(value, "utf8");
    this.u16(encoded.length);
    this.bytes(encoded);
  }

  payload(tag: Tag): void {
    switch (tag.t) {
      case 1: this.i8(tag.v); break;
      case 2: this.i16(tag.v); break;
      case 3: this.i32(tag.v); break;
      case 4: this.i64(tag.v); break;
      case 5: this.f32(tag.v); break;
      case 6: this.f64(tag.v); break;
      case 7: {
        this.i32(tag.v.length);
        for (let i = 0; i < tag.v.length; i += 1) this.i8(tag.v[i]!);
        break;
      }
      case 8: this.str(tag.v); break;
      case 9: {
        const elementType = tag.items[0]?.t ?? 0;
        this.u8(elementType);
        this.i32(tag.items.length);
        for (const item of tag.items) this.payload(item);
        break;
      }
      case 10: {
        for (const [name, value] of Object.entries(tag.v)) {
          this.u8(value.t);
          this.str(name);
          this.payload(value);
        }
        this.u8(0);
        break;
      }
      case 11: {
        this.i32(tag.v.length);
        for (let i = 0; i < tag.v.length; i += 1) this.i32(tag.v[i]!);
        break;
      }
      case 12: {
        this.i32(tag.v.length);
        for (let i = 0; i < tag.v.length; i += 1) this.i64(tag.v[i]!);
        break;
      }
    }
  }

  toBuffer(): Buffer { return Buffer.concat(this.chunks); }
}

/** Reads a player/world .dat file (gzip, zlib or raw) and returns its root compound. */
export function readNbtFile(path: string): Compound | null {
  try {
    const raw = readFileSync(path);
    let buffer = raw;
    if (raw[0] === 0x1f && raw[1] === 0x8b) buffer = gunzipSync(raw);
    else if (raw[0] === 0x78) buffer = require("node:zlib").inflateSync(raw);
    const reader = new Reader(buffer);
    const rootType = reader.u8();
    if (rootType !== 10) return null;
    reader.str(); // root name is empty for player data
    const root = reader.payload(10);
    return root.t === 10 ? root.v : null;
  } catch {
    return null;
  }
}

/** Serialises a root compound to gzipped NBT, the way Minecraft writes player files. */
export function encodeNbtGzip(root: Compound): Buffer {
  const writer = new Writer();
  writer.u8(10);
  writer.str("");
  writer.payload({ t: 10, v: root });
  return gzipSync(writer.toBuffer());
}

/**
 * Writes the file atomically and keeps one `.bak` copy of the previous contents, because a
 * corrupted player file costs the player their whole inventory.
 */
export function writeNbtFile(path: string, root: Compound): void {
  const encoded = encodeNbtGzip(root);
  if (existsSync(path)) {
    try { copyFileSync(path, `${path}.bak`); } catch { /* best effort */ }
  }
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, encoded);
  renameSync(temporary, path);
}

/* --------------------------- typed accessors --------------------------- */

export function num(tag: Tag | undefined): number | null {
  if (!tag) return null;
  switch (tag.t) {
    case 1: case 2: case 3: case 5: case 6: return tag.v;
    case 4: return Number(tag.v);
    default: return null;
  }
}

export function str(tag: Tag | undefined): string | null {
  return tag && tag.t === 8 ? tag.v : null;
}

export function comp(tag: Tag | undefined): Compound | null {
  return tag && tag.t === 10 ? tag.v : null;
}

export function list(tag: Tag | undefined): Tag[] {
  return tag && tag.t === 9 ? tag.items : [];
}

export const byte = (value: number): Tag => ({ t: 1, v: value });
export const short = (value: number): Tag => ({ t: 2, v: value });
export const int = (value: number): Tag => ({ t: 3, v: value });
export const long = (value: bigint): Tag => ({ t: 4, v: value });
export const float = (value: number): Tag => ({ t: 5, v: value });
export const double = (value: number): Tag => ({ t: 6, v: value });
export const string = (value: string): Tag => ({ t: 8, v: value });
export const compound = (value: Compound): Tag => ({ t: 10, v: value });
export const listOf = (items: Tag[]): Tag => ({ t: 9, items });

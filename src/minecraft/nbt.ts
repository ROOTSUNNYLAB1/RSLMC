import { readFileSync } from "node:fs";
import { gunzipSync, inflateSync } from "node:zlib";

/**
 * Minimal read-only NBT parser (uncompressed, gzip or zlib) — used to read level.dat
 * metadata such as the world seed without pulling in a dependency.
 */
export type NbtValue =
  | { type: "byte" | "short" | "int" | "long" | "float" | "double"; value: number }
  | { type: "string"; value: string }
  | { type: "byteArray" | "intArray" | "longArray"; value: ArrayLike<number> }
  | { type: "list"; items: NbtValue[] }
  | { type: "compound"; value: Record<string, NbtValue> };

class Reader {
  offset = 0;
  constructor(private buffer: Buffer) {}
  byte(): number { const v = this.buffer.readInt8(this.offset); this.offset += 1; return v; }
  ubyte(): number { const v = this.buffer.readUInt8(this.offset); this.offset += 1; return v; }
  short(): number { const v = this.buffer.readInt16BE(this.offset); this.offset += 2; return v; }
  ushort(): number { const v = this.buffer.readUInt16BE(this.offset); this.offset += 2; return v; }
  int(): number { const v = this.buffer.readInt32BE(this.offset); this.offset += 4; return v; }
  long(): bigint { const v = this.buffer.readBigInt64BE(this.offset); this.offset += 8; return v; }
  float(): number { const v = this.buffer.readFloatBE(this.offset); this.offset += 4; return v; }
  double(): number { const v = this.buffer.readDoubleBE(this.offset); this.offset += 8; return v; }
  string(): string {
    const length = this.ushort();
    const value = this.buffer.toString("utf8", this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  skip(bytes: number) { this.offset += bytes; }
}

function readPayload(reader: Reader, type: number): NbtValue {
  switch (type) {
    case 1: return { type: "byte", value: reader.byte() };
    case 2: return { type: "short", value: reader.short() };
    case 3: return { type: "int", value: reader.int() };
    case 4: return { type: "long", value: Number(reader.long()) };
    case 5: return { type: "float", value: reader.float() };
    case 6: return { type: "double", value: reader.double() };
    case 7: {
      const length = reader.int();
      const value = Buffer.alloc(length);
      for (let i = 0; i < length; i++) value[i] = reader.byte();
      return { type: "byteArray", value };
    }
    case 8: return { type: "string", value: reader.string() };
    case 9: {
      const itemType = reader.ubyte();
      const length = reader.int();
      const items: NbtValue[] = [];
      for (let i = 0; i < length; i++) items.push(readPayload(reader, itemType));
      return { type: "list", items };
    }
    case 10: {
      const value: Record<string, NbtValue> = {};
      while (true) {
        const childType = reader.ubyte();
        if (childType === 0) break;
        const name = reader.string();
        value[name] = readPayload(reader, childType);
      }
      return { type: "compound", value };
    }
    case 11: {
      const length = reader.int();
      const value = new Int32Array(length);
      for (let i = 0; i < length; i++) value[i] = reader.int();
      return { type: "intArray", value };
    }
    case 12: {
      const length = reader.int();
      const value: number[] = [];
      for (let i = 0; i < length; i++) value.push(Number(reader.long()));
      return { type: "longArray", value };
    }
    default:
      return { type: "byte", value: 0 };
  }
}

export function parseNbt(path: string): Record<string, NbtValue> | null {
  try {
    const raw = readFileSync(path);
    let buffer = raw;
    if (raw[0] === 0x1f && raw[1] === 0x8b) buffer = gunzipSync(raw);
    else if (raw[0] === 0x78) buffer = inflateSync(raw);
    const reader = new Reader(buffer);
    const rootType = reader.ubyte();
    if (rootType !== 10) return null;
    reader.string(); // root name
    return (readPayload(reader, 10) as { value: Record<string, NbtValue> }).value;
  } catch {
    return null;
  }
}

export function getPath(root: Record<string, NbtValue> | null, path: string[]): NbtValue | null {
  let current: NbtValue | undefined = root ? { type: "compound", value: root } : undefined;
  for (const segment of path) {
    if (!current || current.type !== "compound") return null;
    current = current.value[segment];
  }
  return current ?? null;
}

/** Reads the world seed from level.dat, supporting both legacy and modern layouts. */
export function readWorldSeed(levelDatPath: string): { seed: string | null; lastPlayed: number | null; version: string | null } {
  const root = parseNbt(levelDatPath);
  if (!root) return { seed: null, lastPlayed: null, version: null };
  const data = getPath(root, ["Data"]) ?? getPath(root, ["Level"]);
  const dataCompound = data?.type === "compound" ? data.value : root;

  const candidates = [
    ["WorldGenSettings", "seed"],
    ["seed"],
    ["Level", "RandomSeed"],
  ];
  let seed: string | null = null;
  for (const path of candidates) {
    let current: NbtValue | undefined = { type: "compound", value: dataCompound };
    for (const segment of path) {
      if (!current || current.type !== "compound") { current = undefined; break; }
      current = current.value[segment];
    }
    if (current && "value" in current && typeof current.value === "number") {
      seed = String(current.value);
      break;
    }
  }
  const lastPlayed = getPath(root, ["Data", "LastPlayed"]);
  const version = getPath(root, ["Data", "Version", "Name"]);
  return {
    seed,
    lastPlayed: lastPlayed && "value" in lastPlayed ? Number(lastPlayed.value) : null,
    version: version && "value" in version ? String(version.value) : null,
  };
}

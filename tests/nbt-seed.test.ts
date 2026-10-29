import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { parseNbt, readWorldSeed } from "../src/minecraft/nbt";

/**
 * These fixtures are real NBT byte sequences written the same way the game writes level.dat,
 * so the parser is exercised on data rather than on a mock of itself. No panel data directory
 * is touched — everything lives in a throwaway tmp folder.
 */

const utf = (value: string) => {
  const body = Buffer.from(value, "utf8");
  const length = Buffer.alloc(2);
  length.writeUInt16BE(body.length);
  return Buffer.concat([length, body]);
};
const named = (type: number, name: string, payload: Buffer) => Buffer.concat([Buffer.from([type]), utf(name), payload]);
const longPayload = (value: string | number) => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64BE(BigInt(value));
  return buffer;
};
const compound = (...children: Buffer[]) => Buffer.concat([...children, Buffer.from([0])]);
const root = (data: Buffer) => Buffer.concat([Buffer.from([10]), utf(""), compound(named(10, "Data", data))]);

let dir: string;
const file = (name: string, bytes: Buffer, gzip = true) => {
  const path = join(dir, name);
  writeFileSync(path, gzip ? gzipSync(bytes) : bytes);
  return path;
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "rslmc-nbt-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("level.dat seed reading", () => {
  test("a modern level.dat exposes the seed from WorldGenSettings", () => {
    const path = file(
      "modern.dat",
      root(compound(named(10, "WorldGenSettings", compound(named(4, "seed", longPayload("4172144997902289642")))))),
    );
    expect(readWorldSeed(path).seed).toBe("4172144997902289642");
  });

  test("a 64-bit seed keeps every digit instead of being rounded through Number()", () => {
    const seed = "-4172144997902289642";
    const path = file("big.dat", root(compound(named(4, "RandomSeed", longPayload(seed)))));
    expect(String(Number(seed))).not.toBe(seed); // the float64 path really would lose digits
    expect(readWorldSeed(path).seed).toBe(seed);
  });

  test("a legacy pre-1.13 level.dat is read from Level/RandomSeed", () => {
    const path = file(
      "legacy.dat",
      Buffer.concat([
        Buffer.from([10]),
        utf(""),
        compound(
          named(
            10,
            "Data",
            compound(named(10, "Level", compound(named(4, "RandomSeed", longPayload(12345))))),
          ),
        ),
      ]),
    );
    expect(readWorldSeed(path).seed).toBe("12345");
  });

  test("an uncompressed level.dat is read too", () => {
    const path = file("plain.dat", root(compound(named(4, "seed", longPayload(7)))), false);
    expect(readWorldSeed(path).seed).toBe("7");
  });

  test("version and LastPlayed come back from Data when present", () => {
    const path = file(
      "meta.dat",
      root(
        compound(
          named(4, "seed", longPayload(1)),
          named(4, "LastPlayed", longPayload(1793332800000)),
          named(10, "Version", compound(named(8, "Name", utf("1.21.4")))),
        ),
      ),
    );
    const meta = readWorldSeed(path);
    expect(meta.version).toBe("1.21.4");
    expect(meta.lastPlayed).toBe(1793332800000);
  });

  test("a level.dat with no seed reports null rather than inventing one", () => {
    const path = file("noseed.dat", root(compound(named(8, "LevelName", utf("world")))));
    expect(readWorldSeed(path)).toEqual({ seed: null, lastPlayed: null, version: null });
  });

  test("garbage bytes are rejected quietly instead of throwing", () => {
    const path = file("garbage.dat", Buffer.alloc(64, 3));
    expect(parseNbt(path)).toBeNull();
    expect(readWorldSeed(path).seed).toBeNull();
  });

  test("a missing file is not an exception", () => {
    expect(readWorldSeed(join(dir, "nope.dat"))).toEqual({ seed: null, lastPlayed: null, version: null });
  });
});

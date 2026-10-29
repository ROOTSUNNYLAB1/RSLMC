import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  escapePropertyValue, isNamespacedId, normalisePropertyValue, parseProperties,
  readProperties, unescapePropertyValue, writeProperties,
} from "../src/minecraft/properties";

const RESERVED = new Set<string>();

describe("server.properties escaping", () => {
  // Exactly what a real Paper 1.21 file contains — this is what broke saving from the panel.
  const realFile = [
    "#Minecraft server properties",
    "level-type=minecraft\\:normal",
    "motd=A Minecraft Server",
    "server-port=25565",
    "generator-settings={}",
    "level-seed=-12345",
    "max-players=20",
  ].join("\n");

  test("escaped colons are unescaped when reading", () => {
    const { values } = parseProperties(realFile);
    expect(values["level-type"]).toBe("minecraft:normal");
    expect(values["level-type"]).not.toContain("\\");
    expect(values["motd"]).toBe("A Minecraft Server");
  });

  test("saving any other option no longer fails validation", () => {
    const dir = mkdtempSync(join(tmpdir(), "rslmc-props-"));
    writeFileSync(join(dir, "server.properties"), realFile);
    // Change an unrelated toggle while level-type keeps its (unescaped) value — this used to throw
    // "World type must be one of: minecraft:normal, …".
    const result = writeProperties(dir, { pvp: "false", "level-type": "minecraft:normal" }, RESERVED);
    expect(result.changed).toContain("pvp");
    const raw = readFileSync(join(dir, "server.properties"), "utf8");
    expect(raw).toContain("pvp=false");
    expect(raw).toContain("level-type=minecraft\\:normal"); // written the way Minecraft writes it
    expect(readProperties(dir).values["pvp"]).toBe("false");
    rmSync(dir, { recursive: true, force: true });
  });

  test("changing the world type works", () => {
    const dir = mkdtempSync(join(tmpdir(), "rslmc-props-"));
    writeFileSync(join(dir, "server.properties"), realFile);
    writeProperties(dir, { "level-type": "minecraft:flat" }, RESERVED);
    expect(readProperties(dir).values["level-type"]).toBe("minecraft:flat");
    rmSync(dir, { recursive: true, force: true });
  });

  test("legacy and bare world-type names are canonicalised", () => {
    expect(normalisePropertyValue("level-type", "DEFAULT")).toBe("minecraft:normal");
    expect(normalisePropertyValue("level-type", "FLAT")).toBe("minecraft:flat");
    expect(normalisePropertyValue("level-type", "LARGEBIOMES")).toBe("minecraft:large_biomes");
    expect(normalisePropertyValue("level-type", "AMPLIFIED")).toBe("minecraft:amplified");
    expect(normalisePropertyValue("level-type", "normal")).toBe("minecraft:normal");
    expect(normalisePropertyValue("level-type", "flat")).toBe("minecraft:flat");
    expect(normalisePropertyValue("level-type", "minecraft:normal")).toBe("minecraft:normal");
    // Other properties are untouched.
    expect(normalisePropertyValue("motd", "DEFAULT")).toBe("DEFAULT");
  });

  test("datapack generators are accepted, junk is not", () => {
    expect(isNamespacedId("terralith:overworld")).toBe(true);
    expect(isNamespacedId("minecraft:normal")).toBe(true);
    expect(isNamespacedId("not a value")).toBe(false);
    expect(isNamespacedId("normal")).toBe(false);

    const dir = mkdtempSync(join(tmpdir(), "rslmc-props-"));
    writeFileSync(join(dir, "server.properties"), realFile);
    expect(() => writeProperties(dir, { "level-type": "terralith:overworld" }, RESERVED)).not.toThrow();
    expect(readProperties(dir).values["level-type"]).toBe("terralith:overworld");
    expect(() => writeProperties(dir, { "level-type": "banana bread" }, RESERVED)).toThrow(/World type must be one of/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("escape/unescape round-trips including backslashes and newlines", () => {
    for (const value of ["minecraft:normal", "C:\\\\temp", "line1\nline2", "a=b", "plain"]) {
      expect(unescapePropertyValue(escapePropertyValue(value))).toBe(value);
    }
    expect(escapePropertyValue("minecraft:normal")).toBe("minecraft\\:normal");
    expect(unescapePropertyValue("minecraft\\:normal")).toBe("minecraft:normal");
    expect(unescapePropertyValue("\\u0041BC")).toBe("ABC");
  });
});

describe("managed keys", () => {
  test("a reserved key that actually changes is refused by name", () => {
    const dir = mkdtempSync(join(tmpdir(), "rslmc-managed-"));
    writeFileSync(join(dir, "server.properties"), "server-port=25565\nserver-ip=0.0.0.0\nmotd=hi\n");
    const reserved = new Set(["server-port", "server-ip", "rcon.password"]);
    // Echoing the current value (the editor posts the whole map) is fine.
    expect(() => writeProperties(dir, { "server-port": "25565", motd: "hello" }, reserved)).not.toThrow();
    // Trying to move the port is not.
    expect(() => writeProperties(dir, { "server-port": "22" }, reserved)).toThrow(/managed by RSLMC/);
    expect(readProperties(dir).values["server-port"]).toBe("25565");
  });
});

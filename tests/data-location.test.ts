import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hasDatabase, migrateLegacyData, platformDataCandidates, resolveDataLocation } from "../src/shared/data-location";

function tempDir(prefix = "rslmc-loc-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("data directory location", () => {
  test("Linux uses one folder: /opt/rslmc", () => {
    expect(platformDataCandidates("linux", {}, "/home/user")).toEqual(["/opt/rslmc"]);
    // RSLMC_DATA_ROOT only relocates that folder (tests, other volumes).
    expect(platformDataCandidates("linux", { RSLMC_DATA_ROOT: "/srv" }, "/home/user")).toEqual(["/srv/rslmc"]);
  });

  test("Windows prefers ProgramData and falls back to LOCALAPPDATA", () => {
    const env = { ProgramData: "C:\\ProgramData", LOCALAPPDATA: "C:\\Users\\bob\\AppData\\Local" };
    expect(platformDataCandidates("win32", env, "C:\\Users\\bob")).toEqual([
      "C:\\ProgramData\\RSLMC",
      "C:\\Users\\bob\\AppData\\Local\\RSLMC",
    ]);
    // A per-user profile without ProgramData still resolves to a writable folder.
    const local = platformDataCandidates("win32", { LOCALAPPDATA: "C:\\Users\\bob\\AppData\\Local" }, "C:\\Users\\bob");
    expect(local[0]).toBe("C:\\Users\\bob\\AppData\\Local\\RSLMC");
  });

  test("macOS follows the platform convention", () => {
    expect(platformDataCandidates("darwin", {}, "/Users/bob")).toEqual(["/Users/bob/Library/Application Support/RSLMC"]);
  });

  test("RSLMC_DATA_DIR wins, resolved against the application folder", () => {
    const location = resolveDataLocation({
      rootDir: "/srv/panel", platform: "linux", env: { RSLMC_DATA_DIR: "./var/data" }, probe: () => null,
    });
    expect(location.dir).toBe("/srv/panel/var/data");
    expect(location.source).toBe("env");
    expect(location.note).toBeNull();
    expect(resolveDataLocation({ rootDir: "/srv/panel", platform: "linux", env: { RSLMC_DATA_DIR: "/data/rslmc" }, probe: () => null }).dir).toBe("/data/rslmc");
  });

  test("an unwritable platform folder falls back to <app>/runtime and explains why", () => {
    const probes: string[] = [];
    const location = resolveDataLocation({
      rootDir: "/srv/panel", platform: "linux", env: {},
      probe: (dir) => { probes.push(dir); return dir === "/opt/rslmc" ? "permission denied for /opt/rslmc" : null; },
    });
    expect(probes).toEqual(["/opt/rslmc", "/srv/panel/runtime"]);
    expect(location.dir).toBe("/srv/panel/runtime");
    expect(location.source).toBe("local-fallback");
    expect(location.note).toContain("permission denied");
    expect(location.note).toContain("RSLMC_DATA_DIR");
  });

  test("Windows tries ProgramData first, then LOCALAPPDATA", () => {
    const probes: string[] = [];
    const location = resolveDataLocation({
      rootDir: "C:\\panel", platform: "win32",
      env: { ProgramData: "C:\\ProgramData", LOCALAPPDATA: "C:\\Users\\bob\\AppData\\Local" },
      home: "C:\\Users\\bob",
      probe: (dir) => { probes.push(dir); return dir.includes("ProgramData") ? "permission denied" : null; },
    });
    expect(location.dir).toContain("AppData\\Local\\RSLMC");
    expect(location.source).toBe("platform-default");
    expect(probes).toEqual(["C:\\ProgramData\\RSLMC", "C:\\Users\\bob\\AppData\\Local\\RSLMC"]);
  });
});

describe("legacy data adoption", () => {
  test("an older <app>/runtime install is moved into the new folder", () => {
    const root = tempDir();
    const legacy = join(root, "runtime");
    const target = join(root, "opt", "rslmc");
    mkdirSync(join(legacy, "database"), { recursive: true });
    mkdirSync(join(legacy, "servers", "abc"), { recursive: true });
    writeFileSync(join(legacy, "database", "rslmc.db"), "db-bytes");
    writeFileSync(join(legacy, "servers", "abc", "server.properties"), "motd=hi");
    mkdirSync(join(legacy, "secrets"), { recursive: true });
    writeFileSync(join(legacy, "secrets", "panel.key"), "k");

    const result = migrateLegacyData(target, legacy);
    expect(result.migrated).toBe(true);
    expect(readFileSync(join(target, "database", "rslmc.db"), "utf8")).toBe("db-bytes");
    expect(readFileSync(join(target, "servers", "abc", "server.properties"), "utf8")).toBe("motd=hi");
    expect(result.note).toContain("Moved existing data");
    expect(existsSync(legacy)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("nothing is migrated when the target already has a database", () => {
    const root = tempDir();
    const legacy = join(root, "runtime");
    const target = join(root, "opt", "rslmc");
    mkdirSync(join(legacy, "database"), { recursive: true });
    mkdirSync(join(target, "database"), { recursive: true });
    writeFileSync(join(legacy, "database", "rslmc.db"), "old");
    writeFileSync(join(target, "database", "rslmc.db"), "new");
    const result = migrateLegacyData(target, legacy);
    expect(result.migrated).toBe(false);
    expect(readFileSync(join(target, "database", "rslmc.db"), "utf8")).toBe("new");
    expect(existsSync(join(legacy, "database", "rslmc.db"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("a first run with no legacy data does nothing", () => {
    const root = tempDir();
    const result = migrateLegacyData(join(root, "opt", "rslmc"), join(root, "runtime"));
    expect(result).toEqual({ migrated: false, moved: [], note: null });
    expect(existsSync(join(root, "opt", "rslmc"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("existing installations are never moved behind the operator's back", () => {
  test("a legacy <app>/runtime install keeps being used in place", () => {
    const root = tempDir();
    const legacy = join(root, "runtime");
    mkdirSync(join(legacy, "database"), { recursive: true });
    writeFileSync(join(legacy, "database", "rslmc.db"), "live-db");

    const location = resolveDataLocation({ rootDir: root, platform: "linux", env: {}, legacyDir: legacy, probe: () => null });
    expect(location.dir).toBe(legacy);
    expect(location.source).toBe("existing-install");
    expect(location.note).toContain("kept in place");
    expect(location.note).toContain("scripts/move-data.ts");
    expect(hasDatabase(legacy)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("the platform folder is used for fresh installs and when the move is opted in", () => {
    const root = tempDir();
    const legacy = join(root, "runtime");
    const probes: string[] = [];
    // fresh: no legacy database → platform default
    expect(resolveDataLocation({ rootDir: root, platform: "linux", env: {}, legacyDir: legacy, probe: () => null }).source).toBe("platform-default");
    // opted in (RSLMC_ADOPT_LEGACY=true) → platform default even though legacy data exists
    mkdirSync(join(legacy, "database"), { recursive: true });
    writeFileSync(join(legacy, "database", "rslmc.db"), "live-db");
    const adopted = resolveDataLocation({ rootDir: root, platform: "linux", env: {}, legacyDir: legacy, adoptLegacy: true, probe: (d) => { probes.push(d); return null; } });
    expect(adopted.source).toBe("platform-default");
    expect(adopted.dir).toBe("/opt/rslmc");
    expect(probes).toContain("/opt/rslmc");
    rmSync(root, { recursive: true, force: true });
  });

  test("an explicit RSLMC_DATA_DIR always wins over the legacy folder", () => {
    const root = tempDir();
    const legacy = join(root, "runtime");
    mkdirSync(join(legacy, "database"), { recursive: true });
    writeFileSync(join(legacy, "database", "rslmc.db"), "live-db");
    const location = resolveDataLocation({ rootDir: root, platform: "linux", env: { RSLMC_DATA_DIR: "/srv/minecraft" }, legacyDir: legacy });
    expect(location.dir).toBe("/srv/minecraft");
    expect(location.source).toBe("env");
    rmSync(root, { recursive: true, force: true });
  });
});

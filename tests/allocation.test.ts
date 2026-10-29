import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_ROLES, DANGEROUS_PERMISSIONS, roleHasAdminAccess } from "../src/shared/permissions";

const DATA_DIR = mkdtempSync(join(tmpdir(), "rslmc-alloc-"));
process.env.RSLMC_DATA_DIR = DATA_DIR;

let db: typeof import("../src/database");
let servers: typeof import("../src/services/servers");
let auth: typeof import("../src/auth");
let adminId = 0;
let userId = 0;
let otherId = 0;
let firstServer = 0;
let secondServer = 0;

beforeAll(async () => {
  const bootstrap = await import("../src/services/bootstrap");
  db = await import("../src/database");
  servers = await import("../src/services/servers");
  auth = await import("../src/auth");
  await bootstrap.bootstrap();

  adminId = db.queryOne<{ id: number }>("SELECT id FROM users WHERE username = 'admin'")!.id;
  const roleId = db.queryOne<{ id: number }>("SELECT id FROM roles WHERE name = 'User'")!.id;
  const mk = (username: string): number => {
    const id = db.insert(
      "INSERT INTO users (username, password_hash, avatar_color) VALUES (?, 'x', '#1f6f4a')",
      [username],
    );
    db.run("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)", [id, roleId]);
    return id;
  };
  userId = mk("player1");
  otherId = mk("player2");

  const nodeId = db.queryOne<{ id: number }>("SELECT id FROM nodes WHERE is_local = 1")!.id;
  const mkServer = (name: string, port: number, ownerId: number): number => {
    const id = db.insert(
      `INSERT INTO servers (uuid, name, owner_id, node_id, software, mc_version, port, memory_mb)
       VALUES (?, ?, ?, ?, 'paper', '1.21.4', ?, 1024)`,
      [crypto.randomUUID(), name, ownerId, nodeId, port],
    );
    db.insert("INSERT INTO allocations (node_id, ip, port, server_id) VALUES (?, '0.0.0.0', ?, ?)", [nodeId, port, id]);
    return id;
  };
  firstServer = mkServer("Alpha", 25601, otherId);
  secondServer = mkServer("Beta", 25602, adminId);
});

describe("User role", () => {
  test("exists in the default catalogue and carries no dangerous permission", () => {
    const role = DEFAULT_ROLES.find((entry) => entry.name === "User");
    expect(role).toBeDefined();
    const granted = role!.permissions as string[];
    for (const dangerous of DANGEROUS_PERMISSIONS) {
      expect(granted).not.toContain(dangerous);
    }
    expect(roleHasAdminAccess(granted)).toBe(false);
    // …but it can actually run a Minecraft server.
    for (const safe of ["server.view", "server.start", "server.stop", "server.restart", "server.kill", "server.startup", "server.command"]) {
      expect(granted).toContain(safe);
    }
  });

  test("administrator and Server Manager are still flagged as privileged", () => {
    const admin = DEFAULT_ROLES.find((entry) => entry.name === "Administrator")!;
    expect(roleHasAdminAccess(admin.permissions as string[])).toBe(true);
  });

  test("a User can only see servers allocated to it", () => {
    const user = auth.publicUser(auth.findUserById(userId)!);
    expect(servers.listServersForUser(user)).toHaveLength(0);
    expect(servers.listServersForAllocation(userId).every((entry) => entry.relation === "none")).toBe(true);
    expect(auth.canAccessServer(user, firstServer)).toBe(false);
  });
});

describe("server allocation by an administrator", () => {
  test("shared access makes a server readable without moving ownership", () => {
    servers.setUserServerAccess(userId, { shared: [firstServer], reassignOwnerTo: adminId });
    const user = auth.publicUser(auth.findUserById(userId)!);
    expect(auth.canAccessServer(user, firstServer)).toBe(true);
    expect(servers.listServersForUser(user).map((entry) => entry.name)).toEqual(["Alpha"]);
    const ownerId = db.queryOne<{ owner_id: number }>("SELECT owner_id FROM servers WHERE id = ?", [firstServer])!.owner_id;
    expect(ownerId).toBe(otherId);
  });

  test("ownership can be handed to the user and moved on again", () => {
    servers.setUserServerAccess(userId, { owner: [secondServer], reassignOwnerTo: adminId });
    const ownerId = db.queryOne<{ owner_id: number }>("SELECT owner_id FROM servers WHERE id = ?", [secondServer])!.owner_id;
    expect(ownerId).toBe(userId);

    // Taking it away hands it back to the acting administrator instead of leaving it ownerless.
    const result = servers.setUserServerAccess(userId, { owner: [], reassignOwnerTo: adminId });
    expect(result.ownerRemoved).toEqual([secondServer]);
    const after = db.queryOne<{ owner_id: number }>("SELECT owner_id FROM servers WHERE id = ?", [secondServer])!.owner_id;
    expect(after).toBe(adminId);
  });

  test("revoking shared access removes the server from the account's list", () => {
    servers.setUserServerAccess(userId, { owner: [], shared: [], reassignOwnerTo: adminId });
    const user = auth.publicUser(auth.findUserById(userId)!);
    expect(servers.listServersForUser(user)).toHaveLength(0);
    expect(auth.canAccessServer(user, firstServer)).toBe(false);
  });

  test("unknown servers and owned+shared overlaps are rejected", () => {
    expect(() => servers.setUserServerAccess(userId, { shared: [999_999] })).toThrow(/does not exist/);
    expect(() => servers.setUserServerAccess(userId, { owner: [firstServer], shared: [firstServer] }))
      .toThrow(/both owned and shared/);
  });

  test("allocation never grants permissions — the role still decides", () => {
    servers.setUserServerAccess(userId, { owner: [firstServer, secondServer], reassignOwnerTo: adminId });
    const user = auth.publicUser(auth.findUserById(userId)!);
    expect(servers.listServersForUser(user)).toHaveLength(2);
    // Owning a server does not unlock resource settings, networking or the admin area.
    expect(auth.hasPermission(user, "server.start")).toBe(true);
    expect(auth.hasPermission(user, "server.kill")).toBe(true);
    expect(auth.hasPermission(user, "server.startup")).toBe(true);
    expect(auth.hasPermission(user, "server.settings")).toBe(false);
    expect(auth.hasPermission(user, "server.allocations")).toBe(false);
    expect(auth.hasPermission(user, "node.view")).toBe(false);
    expect(() => auth.requirePermission(user, "server.delete")).toThrow();
  });
});

describe("limited startup presets", () => {
  test("no preset carries its own memory or stack flags", () => {
    // The heap must always come from the allocation; a preset that set -Xmx would let an account
    // hand itself more RAM than the administrator granted.
    const { JVM_PRESETS } = require("../src/minecraft/jvm-presets") as typeof import("../src/minecraft/jvm-presets");
    for (const preset of JVM_PRESETS) {
      // A native *cap* (-XX:MaxDirectMemorySize=128M in `lowmem`) only limits, so it is allowed;
      // what must never appear is anything that raises the heap or the stack size.
      expect(preset.flags).not.toMatch(/(^|\s)-(Xm[sx]|Xss|XX:MaxRAM|XX:MaxHeapSize|XX:InitialHeapSize)/);
    }
  });

  test("the curated list still contains the safe presets", () => {
    const { JVM_PRESETS, detectJvmPreset, defaultJvmArgsFor, heapMbFor } = require("../src/minecraft/jvm-presets") as typeof import("../src/minecraft/jvm-presets");
    const ids = JVM_PRESETS.map((preset) => preset.id);
    expect(ids).toContain("aikar");
    expect(ids).toContain("lowmem");
    expect(ids).toContain("proxy");
    // Picking a preset and reading it back round-trips.
    const flags = defaultJvmArgsFor("paper", 2048);
    expect(detectJvmPreset(flags)).toBe(flags.includes("UseSerialGC") ? "lowmem" : "aikar");
    // 2048 MB allocation still yields a heap below the cap, whatever the preset.
    expect(heapMbFor(2048)).toBeLessThan(2048);
  });
});

describe("archive extraction limits", () => {
  test("a tar entry claiming 8 GB is refused instead of writing it", async () => {
    const { extractTarGz } = await import("../src/shared/archive");
    const { gzipSync } = await import("node:zlib");
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    /*
     * The classic compression bomb: a tiny archive whose header claims an enormous payload. The
     * reader must refuse it on the budget (or on truncation) rather than starting a multi-gigabyte
     * write that would fill the disk and take the panel down with it.
     */
    const header = Buffer.alloc(512);
    header.write("bomb.bin", 0, "utf8");
    header.write("0000644\0", 100, "ascii");
    header.write((8 * 1024 * 1024 * 1024).toString(8).padStart(11, "0") + "\0", 124, "ascii");
    header.write("00000000000\0", 136, "ascii");
    header.write("0", 156, "ascii");
    header.fill(" ", 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");

    const dir = mkdtempSync(join(tmpdir(), "rslmc-bomb-"));
    const archive = join(dir, "bomb.tar.gz");
    writeFileSync(archive, gzipSync(Buffer.concat([header, Buffer.alloc(1024, 0)])));

    expect(() => extractTarGz(archive, join(dir, "out"))).toThrow(/truncated|corrupt|limit|expands/i);
  });
});

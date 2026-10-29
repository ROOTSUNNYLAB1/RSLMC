import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/*
 * End-to-end coverage of self-registration against a throwaway data root: the same SQLite schema,
 * the same bootstrap, the same service functions the HTTP routes call.
 */
const DATA_DIR = mkdtempSync(join(tmpdir(), "rslmc-reg-"));
process.env.RSLMC_DATA_DIR = DATA_DIR;

let register: typeof import("../src/services/registration");
let bootstrap: typeof import("../src/services/bootstrap");
let users: typeof import("../src/auth");

beforeAll(async () => {
  bootstrap = await import("../src/services/bootstrap");
  register = await import("../src/services/registration");
  users = await import("../src/auth");
  await bootstrap.bootstrap();
});

const PASSWORD = "Str0ngPass!23";

describe("self-registration", () => {
  test("is closed until an administrator opens it", async () => {
    expect(register.registrationOpen().open).toBe(false);
    await expect(
      register.registerAccount({ username: "earlybird", password: PASSWORD, ip: "127.0.0.1" }),
    ).rejects.toThrow(/disabled by the administrator/i);
    // The public view never leaks the invite code or the user list.
    const info = register.publicRegistrationInfo();
    expect(info.enabled).toBe(false);
    expect(JSON.stringify(info)).not.toContain("inviteCode");
  });

  test("creates an account with the configured default role", async () => {
    register.writeRegistrationConfig({ enabled: true, defaultRole: "Server Manager" });
    const created = await register.registerAccount({ username: "builder", password: PASSWORD, ip: "10.0.0.1" });
    expect(created.role).toBe("Server Manager");
    const user = users.findUserByUsername("builder")!;
    expect(user.disabled).toBe(0);
    expect(user.is_root).toBe(0);
    expect(user.password_hash).not.toContain(PASSWORD);
    expect(users.rolesForUser(user.id)).toEqual(["Server Manager"]);
  });

  test("rejects weak passwords, reserved and duplicate usernames", async () => {
    await expect(
      register.registerAccount({ username: "weakling", password: "short", ip: "10.0.0.2" }),
    ).rejects.toThrow(/security requirements/i);
    await expect(
      register.registerAccount({ username: "admin", password: PASSWORD, ip: "10.0.0.2" }),
    ).rejects.toThrow(/reserved/i);
    await expect(
      register.registerAccount({ username: "BUILDER", password: PASSWORD, ip: "10.0.0.2" }),
    ).rejects.toThrow(/already taken/i);
  });

  test("a new account defaults to the plain User role with no administrator access", async () => {
    register.writeRegistrationConfig({ defaultRole: "User" });
    const created = await register.registerAccount({ username: "plainjoe", password: PASSWORD, ip: "10.0.0.3" });
    expect(created.role).toBe("User");
    const user = users.findUserByUsername("plainjoe")!;
    // Active immediately — there is no approval queue any more.
    expect(user.disabled).toBe(0);
    const publicUser = users.publicUser(user);
    expect(publicUser.permissions).not.toContain("node.view");
    expect(publicUser.permissions).not.toContain("user.view");
    expect(publicUser.permissions).not.toContain("system.manage");
    for (const dangerous of ["server.create", "server.delete", "server.settings", "server.allocations"]) {
      expect(publicUser.permissions).not.toContain(dangerous);
    }
    // A registered account can reach the safe server pages, and can sign in straight away.
    // Force-kill is allowed (a hung JVM on its own server) and so is picking a JVM preset.
    for (const safe of ["server.view", "server.start", "server.stop", "server.kill", "server.startup", "server.command", "server.files", "server.players"]) {
      expect(publicUser.permissions).toContain(safe);
    }
    const session = await users.login("plainjoe", PASSWORD, undefined, { ip: "10.0.0.3", userAgent: "test" });
    expect(session.user.username).toBe("plainjoe");
  });

  test("an invite code is required, checked exactly, and never echoed", async () => {
    register.writeRegistrationConfig({ requireCode: true, inviteCode: "diamond-2026" });
    await expect(
      register.registerAccount({ username: "coded", password: PASSWORD, ip: "10.0.0.4" }),
    ).rejects.toThrow(/sign-up code/i);
    await expect(
      register.registerAccount({ username: "coded", password: PASSWORD, code: "wrong-code", ip: "10.0.0.4" }),
    ).rejects.toThrow(/sign-up code/i);
    const ok = await register.registerAccount({
      username: "coded", password: PASSWORD, code: "diamond-2026", ip: "10.0.0.4",
    });
    expect(ok.role).toBeTruthy();
    expect(register.readRegistrationConfig().codeSet).toBe(true);
    expect(JSON.stringify(register.publicRegistrationInfo())).not.toContain("diamond-2026");
  });

  test("configuration rejects unknown roles and too-short codes", () => {
    expect(() => register.writeRegistrationConfig({ defaultRole: "Wizard" })).toThrow(/no role called/i);
    expect(() => register.writeRegistrationConfig({ inviteCode: "abc" })).toThrow(/at least 6 characters/i);
  });

  test("disabling registration closes the public endpoint again", () => {
    register.writeRegistrationConfig({ enabled: false });
    const info = register.publicRegistrationInfo();
    expect(info.enabled).toBe(false);
    expect(info.requireCode).toBe(false);
    expect(info.message).toMatch(/disabled/i);
  });
});

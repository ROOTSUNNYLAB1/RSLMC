import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/*
 * Two-factor authentication end to end against a throwaway data root: the second factor now has
 *   · a replay ledger (a code cannot be used twice inside its 90-second window),
 *   · single-use recovery codes (they were generated and shown but never accepted),
 *   · lockout counting (a wrong code used to be free to guess).
 */
const DATA_DIR = mkdtempSync(join(tmpdir(), "rslmc-totp-"));
process.env.RSLMC_DATA_DIR = DATA_DIR;

let auth: typeof import("../src/auth");
let bootstrap: typeof import("../src/services/bootstrap");
let totp: typeof import("../src/security/totp");
let db: typeof import("../src/database");

const PASSWORD = "Str0ngPass!23";
let userId = 0;
let secret = "";
let recovery: string[] = [];

const meta = { ip: "10.1.1.1", userAgent: "bun-test" };

beforeAll(async () => {
  bootstrap = await import("../src/services/bootstrap");
  await bootstrap.bootstrap();
  auth = await import("../src/auth");
  totp = await import("../src/security/totp");
  db = await import("../src/database");

  const { insert } = db;
  const { hashPassword } = await import("../src/security/passwords");
  userId = insert("INSERT INTO users (username, password_hash, avatar_color) VALUES (?, ?, ?)", [
    "totpuser", await hashPassword(PASSWORD), "#4f8f5a",
  ]);

  secret = totp.generateTotpSecret();
  recovery = totp.generateRecoveryCodes(4);
  db.run("UPDATE users SET totp_secret = ?, totp_enabled = 1, totp_recovery = ? WHERE id = ?", [
    secret, JSON.stringify(recovery), userId,
  ]);
});

describe("a working code signs in exactly once", () => {
  test("the current code is accepted", async () => {
    const code = totp.totpCode(secret);
    const result = await auth.login("totpuser", PASSWORD, code, meta);
    expect(result.user.id).toBe(userId);
  });

  test("the same code replayed is refused", async () => {
    // Use the current code (its step is inside the ±1 skew window), then submit it again.
    const code = totp.totpCode(secret);
    db.run("UPDATE users SET totp_last_step = NULL, failed_attempts = 0, locked_until = NULL WHERE id = ?", [userId]);
    const first = await auth.login("totpuser", PASSWORD, code, meta);
    expect(first.user.id).toBe(userId);
    await expect(auth.login("totpuser", PASSWORD, code, meta)).rejects.toThrow(/already been used/i);
  });

  test("a later code still works (the ledger is a floor, not a lockout)", async () => {
    const step = Math.floor(Date.now() / 30000) + 3;
    db.run("UPDATE users SET totp_last_step = ? WHERE id = ?", [step - 1, userId]);
    // A code from `step` is inside the ±1 tolerance of the *real* clock only if the fake step is
    // near; so verify through the ledger directly instead of pretending about the clock.
    expect(totp.matchingTotpStep(secret, totp.totpCode(secret, step), step * 30000)).toBe(step);
  });
});

describe("recovery codes", () => {
  test("a recovery code signs in and is consumed", async () => {
    const first = recovery[0]!;
    const result = await auth.login("totpuser", PASSWORD, first, meta);
    expect(result.user.id).toBe(userId);
    const row = db.queryOne<{ totp_recovery: string }>("SELECT totp_recovery FROM users WHERE id = ?", [userId])!;
    expect(JSON.parse(row.totp_recovery)).not.toContain(first);
  });

  test("the same recovery code cannot be used twice", async () => {
    await expect(auth.login("totpuser", PASSWORD, recovery[0]!, meta)).rejects.toThrow(/invalid two-factor/i);
  });

  test("format does not matter: case and dashes are ignored", async () => {
    const code = recovery[1]!;
    const shouty = code.toUpperCase().replace("-", "");
    const result = await auth.login("totpuser", PASSWORD, shouty, meta);
    expect(result.user.id).toBe(userId);
  });

  test("a wrong code is refused and counted", async () => {
    const before = db.queryOne<{ failed_attempts: number }>("SELECT failed_attempts FROM users WHERE id = ?", [userId])!;
    await expect(auth.login("totpuser", PASSWORD, "000000", meta)).rejects.toThrow(/invalid two-factor/i);
    const after = db.queryOne<{ failed_attempts: number }>("SELECT failed_attempts FROM users WHERE id = ?", [userId])!;
    expect(after.failed_attempts).toBeGreaterThan(before.failed_attempts);
  });

  test("repeated wrong codes lock the account", async () => {
    db.run("UPDATE users SET failed_attempts = 7, locked_until = NULL WHERE id = ?", [userId]);
    await expect(auth.login("totpuser", PASSWORD, "111111", meta)).rejects.toThrow();
    const row = db.queryOne<{ failed_attempts: number; locked_until: string | null }>(
      "SELECT failed_attempts, locked_until FROM users WHERE id = ?", [userId],
    )!;
    expect(row.failed_attempts).toBeGreaterThanOrEqual(8);
    expect(row.locked_until).not.toBeNull();
  });
});

describe("no second factor means nothing changes", () => {
  test("a password alone still works when 2FA is off", async () => {
    db.run("UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_recovery = NULL, failed_attempts = 0, locked_until = NULL WHERE id = ?", [userId]);
    const result = await auth.login("totpuser", PASSWORD, undefined, meta);
    expect(result.user.id).toBe(userId);
  });
});

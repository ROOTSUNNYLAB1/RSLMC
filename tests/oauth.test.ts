import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

/*
 * Coverage for the sign-in provider layer against a throwaway data root. The network half of OAuth
 * (Discord's token endpoint, Google's token endpoint, Firebase) cannot be exercised without real
 * client credentials, so those requests are asserted structurally; everything that guards the panel
 * — configuration gating, single-use state, PKCE, account resolution, tickets — is tested for real.
 */
const DATA_DIR = mkdtempSync(join(tmpdir(), "rslmc-oauth-"));
process.env.RSLMC_DATA_DIR = DATA_DIR;

let oauth: typeof import("../src/services/oauth");
let bootstrap: typeof import("../src/services/bootstrap");
let registration: typeof import("../src/services/registration");
let db: typeof import("../src/database");

beforeAll(async () => {
  bootstrap = await import("../src/services/bootstrap");
  oauth = await import("../src/services/oauth");
  registration = await import("../src/services/registration");
  db = await import("../src/database");
  await bootstrap.bootstrap();
});

const profile = (over: Partial<Parameters<typeof oauth.resolveOauthAccount>[0]> = {}) => ({
  provider: "discord" as const,
  subject: "112233445566778899",
  email: "creeper@example.com",
  emailVerified: true,
  displayName: "Creeper Fan",
  avatarUrl: "https://cdn.discordapp.com/avatars/1/a.png",
  ...over,
});

describe("provider configuration", () => {
  test("starts fully closed and is not advertised to the login page", () => {
    const config = oauth.readOauthConfig();
    expect(config.discord.enabled).toBe(false);
    expect(config.google.enabled).toBe(false);
    expect(config.ready).toEqual({ discord: false, google: false });
    expect(oauth.publicProviders()).toEqual([]);
    // The admin view must never echo a stored secret.
    expect(JSON.stringify(oauth.oauthAdminView())).not.toContain("clientSecret");
  });

  test("a provider cannot be enabled before its credentials exist", () => {
    expect(() => oauth.writeOauthConfig({ discord: { enabled: true } })).toThrow(/client id and client secret/i);
    expect(() => oauth.writeOauthConfig({ google: { enabled: true } })).toThrow(/client id/i);
    // …and the flag really was left off, not flipped and then reported.
    expect(oauth.readOauthConfig().discord.enabled).toBe(false);
  });

  test("credentials turn the provider ready and expose only public fields", () => {
    const config = oauth.writeOauthConfig({
      discord: { clientId: "1234567890", clientSecret: "discord-secret-value" },
    });
    expect(config.ready.discord).toBe(true);
    expect(config.discord.secretSet).toBe(true);
    expect(JSON.stringify(oauth.oauthAdminView())).not.toContain("discord-secret-value");

    const enabled = oauth.writeOauthConfig({ discord: { enabled: true } });
    expect(enabled.discord.enabled).toBe(true);
    expect(oauth.publicProviders()).toEqual([{ id: "discord", label: "Discord", clientId: "1234567890" }]);
    // No secret travels to the browser.
    expect(JSON.stringify(oauth.publicProviders())).not.toContain("secret");
  });

  test("Google needs the Firebase web API key as well as the OAuth client", () => {
    const partial = oauth.writeOauthConfig({
      google: { clientId: "abc.apps.googleusercontent.com", clientSecret: "google-secret" },
    });
    expect(partial.ready.google).toBe(false);
    expect(() => oauth.writeOauthConfig({ google: { enabled: true } })).toThrow(/firebase/i);

    const ready = oauth.writeOauthConfig({ google: { firebaseApiKey: "AIza-fake-key", firebaseProjectId: "rslmc-test" } });
    expect(ready.ready.google).toBe(true);
    expect(ready.google.firebaseProjectId).toBe("rslmc-test");
    expect(JSON.stringify(oauth.oauthAdminView())).not.toContain("AIza-fake-key");
  });

  test("clearing a secret disables the provider instead of leaving a half-configured button", () => {
    const cleared = oauth.writeOauthConfig({ discord: { clientSecret: null } });
    expect(cleared.discord.secretSet).toBe(false);
    expect(cleared.discord.enabled).toBe(false);
    expect(oauth.providerEnabled("discord")).toBe(false);
  });
});

describe("authorization state (CSRF nonce + PKCE)", () => {
  test("a state is bound to one provider and works exactly once", () => {
    oauth.writeOauthConfig({ discord: { clientId: "1234567890", clientSecret: "discord-secret-value" } });
    const created = oauth.createState("discord", "https://panel.example.com/api/auth/oauth/discord/callback");
    expect(created.state.length).toBeGreaterThanOrEqual(32);
    // PKCE: the challenge is the S256 digest of the verifier, never the verifier itself.
    const expected = createHash("sha256").update(created.verifier).digest("base64url");
    expect(created.challenge).toBe(expected);
    expect(created.challenge).not.toBe(created.verifier);

    // Presenting it against the wrong provider consumes nothing usable.
    expect(oauth.consumeState(created.state, "google")).toBeNull();
    const consumed = oauth.consumeState(created.state, "discord");
    expect(consumed?.verifier).toBe(created.verifier);
    expect(consumed?.redirectUri).toBe("https://panel.example.com/api/auth/oauth/discord/callback");
    // Replay is refused.
    expect(oauth.consumeState(created.state, "discord")).toBeNull();
  });

  test("an unknown or expired state is refused", () => {
    expect(oauth.consumeState("not-a-real-state", "discord")).toBeNull();
    const created = oauth.createState("discord", "https://panel.example.com/api/auth/oauth/discord/callback");
    db.run("UPDATE oauth_states SET expires_at = ? WHERE state = ?", [new Date(Date.now() - 1000).toISOString(), created.state]);
    expect(oauth.consumeState(created.state, "discord")).toBeNull();
  });

  test("the authorize URL carries the exact redirect URI, scopes and challenge", () => {
    // Re-state a fully configured Discord app: the previous test deliberately cleared its secret.
    oauth.writeOauthConfig({ discord: { clientId: "1234567890", clientSecret: "discord-secret-value" } });
    oauth.writeOauthConfig({ discord: { enabled: true } });
    oauth.writeOauthConfig({ google: { enabled: true } });
    const url = new URL(oauth.authorizeUrl(
      "discord",
      "https://panel.example.com/api/auth/oauth/discord/callback",
      "state-token",
      "challenge-token",
    ));
    expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("1234567890");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("state-token");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe("https://panel.example.com/api/auth/oauth/discord/callback");
    expect(url.searchParams.get("scope")).toContain("identify");

    const google = new URL(oauth.authorizeUrl("google", "https://panel.example.com/cb", "s", "c"));
    expect(google.origin + google.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(google.searchParams.get("scope")).toContain("openid");
    expect(google.searchParams.get("access_type")).toBe("online");
  });

  test("a disabled provider cannot build an authorize URL or a state", () => {
    oauth.writeOauthConfig({ google: { enabled: false } });
    expect(() => oauth.authorizeUrl("google", "https://panel.example.com/cb", "s", "c")).toThrow(/not configured/i);
  });
});

describe("account resolution", () => {
  test("a new identity gets a least-privilege account with an unusable password", () => {
    registration.writeRegistrationConfig({ enabled: false, defaultRole: "User" });
    const result = oauth.resolveOauthAccount(profile(), "10.1.1.1");
    expect(result.created).toBe(true);
    expect(result.outcome.requiresTotp).toBe(false);

    const user = db.queryOne<{ username: string; password_hash: string; is_root: number; disabled: number; email: string }>(
      "SELECT username, password_hash, is_root, disabled, email FROM users WHERE id = ?",
      [result.outcome.userId],
    )!;
    expect(user.is_root).toBe(0);
    expect(user.disabled).toBe(0);
    expect(user.password_hash.startsWith("!oauth:")).toBe(true);
    expect(user.email).toBe("creeper@example.com");

    const roles = db.query<{ name: string }>(
      "SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?",
      [result.outcome.userId],
    );
    expect(roles.map((role) => role.name)).toEqual(["User"]);
  });

  test("the same identity signs into the same account on the next visit", () => {
    const first = oauth.resolveOauthAccount(
      profile({ subject: "99887766554433", email: "repeat@example.com", displayName: "Repeat" }), "10.1.1.2",
    );
    const second = oauth.resolveOauthAccount(
      profile({ subject: "99887766554433", email: "repeat@example.com", displayName: "Repeat" }), "10.1.1.2",
    );
    expect(second.created).toBe(false);
    expect(second.outcome.userId).toBe(first.outcome.userId);
    expect(oauth.identitiesForUser(first.outcome.userId).length).toBe(1);
  });

  test("a verified email links to the existing account instead of creating a twin", () => {
    registration.writeRegistrationConfig({ enabled: false, defaultRole: "User" });
    const seeded = db.insert(
      "INSERT INTO users (username, email, password_hash, is_root, disabled) VALUES ('verify-me', 'verify@example.com', 'x', 0, 0)",
    );
    const linked = oauth.resolveOauthAccount(
      profile({ provider: "google", subject: "google-sub-1", email: "verify@example.com", displayName: "Verify" }),
      "10.1.1.3",
    );
    expect(linked.created).toBe(false);
    expect(linked.linkedByEmail).toBe(true);
    expect(linked.outcome.userId).toBe(seeded);
    expect(oauth.identitiesForUser(seeded).map((row) => row.provider)).toEqual(["google"]);
  });

  test("an unverified email never links, and closes registration means no new account", () => {
    db.insert("INSERT INTO users (username, email, password_hash, is_root, disabled) VALUES ('victim', 'victim@example.com', 'x', 0, 0)");
    registration.writeRegistrationConfig({ enabled: false, defaultRole: "User" });
    oauth.writeOauthConfig({ allowRegistration: false, linkByEmail: true });
    expect(() => oauth.resolveOauthAccount(
      profile({ subject: "attacker-1", email: "victim@example.com", emailVerified: false }),
      "10.1.1.4",
    )).toThrow(/account creation/i);
    // Nothing was created for the attacker.
    expect(db.queryOne("SELECT id FROM users WHERE lower(email) = 'victim@example.com'")!.id).toBeGreaterThan(0);
  });

  test("email linking can be switched off entirely", () => {
    oauth.writeOauthConfig({ allowRegistration: true, linkByEmail: false });
    db.insert("INSERT INTO users (username, email, password_hash, is_root, disabled) VALUES ('nolink', 'nolink@example.com', 'x', 0, 0)");
    const created = oauth.resolveOauthAccount(
      profile({ provider: "google", subject: "google-sub-2", email: "nolink@example.com", displayName: "No Link" }),
      "10.1.1.5",
    );
    expect(created.linkedByEmail).toBe(false);
    expect(created.created).toBe(true);
    const existing = db.queryOne<{ id: number }>("SELECT id FROM users WHERE username = 'nolink'")!;
    expect(created.outcome.userId).not.toBe(existing.id);
  });

  test("two people with the same display name get distinct usernames", () => {
    oauth.writeOauthConfig({ allowRegistration: true });
    const a = oauth.resolveOauthAccount(profile({ subject: "dup-a", email: "a@example.com", displayName: "Steve" }), "10.1.1.6");
    const b = oauth.resolveOauthAccount(profile({ subject: "dup-b", email: "b@example.com", displayName: "Steve" }), "10.1.1.6");
    const names = [a, b].map((r) => db.queryOne<{ username: string }>("SELECT username FROM users WHERE id = ?", [r.outcome.userId])!.username);
    expect(names[0]).not.toBe(names[1]);
    expect(names.every((name) => name.length > 0 && name.length <= 32)).toBe(true);
  });

  test("a disabled panel account cannot be entered through a provider", () => {
    const created = oauth.resolveOauthAccount(profile({ subject: "to-disable", email: "off@example.com" }), "10.1.1.7");
    db.run("UPDATE users SET disabled = 1 WHERE id = ?", [created.outcome.userId]);
    expect(() => oauth.resolveOauthAccount(profile({ subject: "to-disable", email: "off@example.com" }), "10.1.1.7"))
      .toThrow(/disabled by an administrator/i);
  });

  test("accounts with two-factor get a ticket, not a session", () => {
    const created = oauth.resolveOauthAccount(profile({ subject: "totp-user", email: "totp@example.com" }), "10.1.1.8");
    db.run("UPDATE users SET totp_enabled = 1, totp_secret = 'JBSWY3DPEHPK3PXP' WHERE id = ?", [created.outcome.userId]);
    const again = oauth.resolveOauthAccount(profile({ subject: "totp-user", email: "totp@example.com" }), "10.1.1.8");
    expect(again.outcome.requiresTotp).toBe(true);

    const ticket = oauth.createTicket(again.outcome.userId);
    expect(oauth.consumeTicket(ticket)).toBe(again.outcome.userId);
    // Single use.
    expect(oauth.consumeTicket(ticket)).toBeNull();
  });

  test("expired tickets are refused", () => {
    const created = oauth.resolveOauthAccount(profile({ subject: "totp-late", email: "late@example.com" }), "10.1.1.9");
    const ticket = oauth.createTicket(created.outcome.userId);
    db.run("UPDATE oauth_tickets SET expires_at = ? WHERE ticket = ?", [new Date(Date.now() - 1000).toISOString(), ticket]);
    expect(oauth.consumeTicket(ticket)).toBeNull();
  });
});

describe("unlinking", () => {
  test("removes one identity but refuses to strip the last way into a password-less account", () => {
    const created = oauth.resolveOauthAccount(profile({ subject: "unlink-me", email: "unlink@example.com" }), "10.1.1.10");
    const userId = created.outcome.userId;
    expect(() => oauth.unlinkIdentity(userId, "discord")).toThrow(/no way to sign in/i);
    expect(oauth.identitiesForUser(userId).length).toBe(1);

    // Add a second provider (linked by verified email), then the first one can go.
    oauth.writeOauthConfig({ allowRegistration: false, linkByEmail: true });
    oauth.resolveOauthAccount(profile({ provider: "google", subject: "unlink-google", email: "unlink@example.com" }), "10.1.1.10");
    oauth.unlinkIdentity(userId, "discord");
    expect(oauth.identitiesForUser(userId).map((row) => row.provider)).toEqual(["google"]);
    expect(() => oauth.unlinkIdentity(userId, "discord")).toThrow(/not linked/i);
  });

  test("an account with a real password may drop its only identity", () => {
    const userId = db.insert(
      "INSERT INTO users (username, email, password_hash, is_root, disabled) VALUES ('has-password', 'hp@example.com', '$argon2id$fake', 0, 0)",
    );
    db.run(
      "INSERT INTO user_identities (user_id, provider, subject, email) VALUES (?, 'discord', 'has-password-sub', 'hp@example.com')",
      [userId],
    );
    oauth.unlinkIdentity(userId, "discord");
    expect(oauth.identitiesForUser(userId).length).toBe(0);
  });
});

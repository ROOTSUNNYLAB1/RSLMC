import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getSetting, setSetting, query, queryOne, insert, run } from "../database";
import { badRequest, ApiException } from "../shared/http";
import { readRegistrationConfig } from "./registration";

/**
 * Single sign-on: Discord (plain OAuth 2.0) and Google **through Firebase**.
 *
 * Why Firebase for Google: the panel serves its own bundled JavaScript and a strict CSP
 * (`script-src 'self'`), so dropping the Firebase web SDK in was not an option. Instead the server
 * runs the ordinary Google OAuth code flow, then hands the resulting Google ID token to Firebase
 * Identity Toolkit (`accounts:signInWithIdp`). Firebase verifies it and returns the Firebase account
 * (localId, email, emailVerified) — that is the "Google login via Firebase" path, and it keeps the
 * Firebase project as the single source of truth for those identities without any browser SDK.
 *
 * Everything here is server-side; the browser only ever sees provider names and client ids.
 */

export type Provider = "discord" | "google";
export const PROVIDERS: Provider[] = ["discord", "google"];

const KEYS = {
  discordEnabled: "oauth.discord.enabled",
  discordClientId: "oauth.discord.clientId",
  discordSecret: "oauth.discord.clientSecret",
  googleEnabled: "oauth.google.enabled",
  googleClientId: "oauth.google.clientId",
  googleSecret: "oauth.google.clientSecret",
  googleApiKey: "oauth.google.firebaseApiKey",
  googleProject: "oauth.google.firebaseProjectId",
  allowRegistration: "oauth.allowRegistration",
  linkByEmail: "oauth.linkByEmail",
} as const;

const STATE_TTL_MS = 10 * 60 * 1000;
const TICKET_TTL_MS = 5 * 60 * 1000;

const flag = (key: string, fallback = false): boolean => {
  const value = getSetting(key, null);
  return value === null ? fallback : value === "1" || value === "true";
};

export interface ProviderConfig {
  enabled: boolean;
  clientId: string;
  /** Secrets are write-only over the API; this only says whether one is stored. */
  secretSet: boolean;
  firebaseApiKeySet?: boolean;
  firebaseProjectId?: string;
}

export interface OauthConfig {
  discord: ProviderConfig;
  google: ProviderConfig;
  allowRegistration: boolean;
  linkByEmail: boolean;
  /** Convenience for the admin UI: what still has to be typed in for the provider to work. */
  ready: { discord: boolean; google: boolean };
}

const blank = (value: string | null | undefined): boolean => !value || value.trim().length === 0;

export function readOauthConfig(): OauthConfig {
  const discord = {
    enabled: flag(KEYS.discordEnabled),
    clientId: getSetting(KEYS.discordClientId, "") ?? "",
    secretSet: !blank(getSetting(KEYS.discordSecret, "")),
  };
  const google = {
    enabled: flag(KEYS.googleEnabled),
    clientId: getSetting(KEYS.googleClientId, "") ?? "",
    secretSet: !blank(getSetting(KEYS.googleSecret, "")),
    firebaseApiKeySet: !blank(getSetting(KEYS.googleApiKey, "")),
    firebaseProjectId: getSetting(KEYS.googleProject, "") ?? "",
  };
  return {
    discord,
    google,
    allowRegistration: flag(KEYS.allowRegistration, true),
    linkByEmail: flag(KEYS.linkByEmail, true),
    ready: {
      discord: discord.clientId.length > 0 && discord.secretSet,
      google: google.clientId.length > 0 && google.secretSet && Boolean(google.firebaseApiKeySet),
    },
  };
}

export interface OauthPatch {
  discord?: { enabled?: boolean; clientId?: string; clientSecret?: string | null };
  google?: {
    enabled?: boolean; clientId?: string; clientSecret?: string | null;
    firebaseApiKey?: string | null; firebaseProjectId?: string;
  };
  allowRegistration?: boolean;
  linkByEmail?: boolean;
}

export function writeOauthConfig(patch: OauthPatch): OauthConfig {
  const put = (key: string, value: string, secret = false) =>
    setSetting(key, value.trim(), secret);

  if (patch.discord) {
    const d = patch.discord;
    if (d.clientId !== undefined) put(KEYS.discordClientId, d.clientId);
    if (d.clientSecret !== undefined) put(KEYS.discordSecret, d.clientSecret ?? "", true);
    if (d.enabled !== undefined) put(KEYS.discordEnabled, d.enabled ? "1" : "0");
  }
  if (patch.google) {
    const g = patch.google;
    if (g.clientId !== undefined) put(KEYS.googleClientId, g.clientId);
    if (g.clientSecret !== undefined) put(KEYS.googleSecret, g.clientSecret ?? "", true);
    if (g.firebaseApiKey !== undefined) put(KEYS.googleApiKey, g.firebaseApiKey ?? "", true);
    if (g.firebaseProjectId !== undefined) put(KEYS.googleProject, g.firebaseProjectId);
    if (g.enabled !== undefined) put(KEYS.googleEnabled, g.enabled ? "1" : "0");
  }
  if (patch.allowRegistration !== undefined) put(KEYS.allowRegistration, patch.allowRegistration ? "1" : "0");
  if (patch.linkByEmail !== undefined) put(KEYS.linkByEmail, patch.linkByEmail ? "1" : "0");

  // A provider that is on without credentials would render a button that can only fail. Clearing a
  // secret therefore just switches the provider off; only an explicit "enable" is an error.
  let next = readOauthConfig();
  if (next.discord.enabled && !next.ready.discord) {
    put(KEYS.discordEnabled, "0");
    if (patch.discord?.enabled === true) {
      throw badRequest("Discord needs a client ID and client secret before it can be enabled.");
    }
    next = readOauthConfig();
  }
  if (next.google.enabled && !next.ready.google) {
    put(KEYS.googleEnabled, "0");
    if (patch.google?.enabled === true) {
      throw badRequest("Google needs an OAuth client ID, client secret and Firebase web API key before it can be enabled.");
    }
    next = readOauthConfig();
  }
  return next;
}

/** What the browser is allowed to know: provider availability and the public client ids. */
export function publicProviders(): { id: Provider; label: string; clientId: string }[] {
  const config = readOauthConfig();
  const out: { id: Provider; label: string; clientId: string }[] = [];
  if (config.discord.enabled && config.ready.discord) {
    out.push({ id: "discord", label: "Discord", clientId: config.discord.clientId });
  }
  if (config.google.enabled && config.ready.google) {
    out.push({ id: "google", label: "Google", clientId: config.google.clientId });
  }
  return out;
}

export function providerEnabled(provider: string): boolean {
  return publicProviders().some((entry) => entry.id === provider);
}

/* ------------------------------------------------------------------ */
/* State + PKCE                                                        */
/* ------------------------------------------------------------------ */

export function createState(provider: Provider, redirectUri: string): { state: string; verifier: string; challenge: string } {
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  run("DELETE FROM oauth_states WHERE expires_at < ?", [new Date().toISOString()]);
  insert(
    "INSERT INTO oauth_states (state, provider, code_verifier, redirect_uri, expires_at) VALUES (?, ?, ?, ?, ?)",
    [state, provider, verifier, redirectUri, new Date(Date.now() + STATE_TTL_MS).toISOString()],
  );
  return { state, verifier, challenge };
}

/**
 * Reads and deletes a state row in one go: a state is valid exactly once, so a replayed callback
 * (or a stolen redirect URL) cannot mint a second session.
 */
export function consumeState(state: string, provider: Provider): { verifier: string; redirectUri: string } | null {
  if (!state) return null;
  const row = queryOne<{ provider: string; code_verifier: string; redirect_uri: string; expires_at: string }>(
    "SELECT provider, code_verifier, redirect_uri, expires_at FROM oauth_states WHERE state = ?", [state],
  );
  if (!row) return null;
  // A callback presented to the wrong provider must not burn a live state (that would be a cheap way
  // to cancel somebody else's sign-in); only the matching callback consumes it.
  if (row.provider !== provider) return null;
  run("DELETE FROM oauth_states WHERE state = ?", [state]);
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return { verifier: row.code_verifier, redirectUri: row.redirect_uri };
}

/* ------------------------------------------------------------------ */
/* Provider wire protocols                                             */
/* ------------------------------------------------------------------ */

export function authorizeUrl(provider: Provider, redirectUri: string, state: string, challenge: string): string {
  const config = readOauthConfig();
  if (!config[provider].enabled || !config.ready[provider]) {
    throw new ApiException(404, "oauth_not_configured", "That sign-in provider is not configured on this panel.");
  }
  if (provider === "discord") {
    const params = new URLSearchParams({
      client_id: config.discord.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: "identify email",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "consent",
    });
    return `https://discord.com/oauth2/authorize?${params.toString()}`;
  }
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "online",
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export interface IdentityProfile {
  provider: Provider;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
}

/** Exchanges the code and returns a normalised profile. Throws ApiException on provider errors. */
export async function fetchProfile(provider: Provider, code: string, redirectUri: string, verifier: string): Promise<IdentityProfile> {
  const config = readOauthConfig();
  const fail = (detail: string) => new ApiException(400, "oauth_failed", detail);

  if (provider === "discord") {
    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.discord.clientId,
        client_secret: getSetting(KEYS.discordSecret, "") ?? "",
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    });
    if (!tokenResponse.ok) throw fail(`Discord rejected the sign-in (${tokenResponse.status}).`);
    const token = await tokenResponse.json() as { access_token?: string };
    if (!token.access_token) throw fail("Discord did not return an access token.");

    const userResponse = await fetch("https://discord.com/api/users/@me", {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    if (!userResponse.ok) throw fail("Discord profile could not be read.");
    const profile = await userResponse.json() as { id?: string; username?: string; global_name?: string; email?: string; verified?: boolean; avatar?: string };
    if (!profile.id) throw fail("Discord did not return an account id.");
    return {
      provider,
      subject: profile.id,
      email: profile.email ?? null,
      // Discord marks an address as verified only when it has been confirmed by the user.
      emailVerified: profile.verified === true,
      displayName: profile.global_name ?? profile.username ?? null,
      avatarUrl: profile.avatar ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png?size=64` : null,
    };
  }

  /* Google → Firebase Identity Toolkit. */
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.google.clientId,
      client_secret: getSetting(KEYS.googleSecret, "") ?? "",
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!tokenResponse.ok) throw fail(`Google rejected the sign-in (${tokenResponse.status}).`);
  const token = await tokenResponse.json() as { id_token?: string };
  if (!token.id_token) throw fail("Google did not return an ID token.");

  const apiKey = getSetting(KEYS.googleApiKey, "") ?? "";
  const firebaseResponse = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        postBody: `id_token=${token.id_token}&providerId=google.com`,
        requestUri: redirectUri,
        returnIdpCredential: false,
        returnSecureToken: true,
      }),
    },
  );
  if (!firebaseResponse.ok) {
    throw fail(`Firebase could not verify the Google account (${firebaseResponse.status}). Check the web API key and that Google is enabled as a sign-in provider in the Firebase console.`);
  }
  const firebase = await firebaseResponse.json() as {
    localId?: string; email?: string; displayName?: string; photoUrl?: string;
    emailVerified?: boolean; idToken?: string;
  };
  if (!firebase.localId) throw fail("Firebase did not return an account.");

  /*
   * The email is taken from the Firebase account record (a fresh, authenticated lookup), not from the
   * unverified client payload, because account linking depends on it being trustworthy.
   */
  let email = firebase.email ?? null;
  let verified = firebase.emailVerified === true;
  if (firebase.idToken) {
    const lookup = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idToken: firebase.idToken }),
      },
    );
    if (lookup.ok) {
      const data = await lookup.json() as { users?: { email?: string; emailVerified?: boolean; displayName?: string; photoUrl?: string }[] };
      const record = data.users?.[0];
      if (record) {
        email = record.email ?? email;
        verified = record.emailVerified === true;
        if (record.displayName && !firebase.displayName) firebase.displayName = record.displayName;
        if (record.photoUrl && !firebase.photoUrl) firebase.photoUrl = record.photoUrl;
      }
    }
  }

  return {
    provider,
    subject: firebase.localId,
    email,
    emailVerified: verified,
    displayName: firebase.displayName ?? null,
    avatarUrl: firebase.photoUrl ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Account mapping                                                     */
/* ------------------------------------------------------------------ */

export interface OauthOutcome {
  userId: number;
  username: string;
  /** True when the session must not be issued yet: the account has TOTP enabled. */
  requiresTotp: boolean;
}

const sanitiseUsername = (raw: string | null, provider: Provider, subject: string): string => {
  const base = (raw ?? `${provider}user`)
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_.-]/g, "")
    .slice(0, 24);
  const suffix = subject.slice(-4).replace(/[^A-Za-z0-9]/g, "") || randomBytes(2).toString("hex");
  const candidate = base.length >= 3 ? base : `${provider}user`;
  return `${candidate.slice(0, 27)}-${suffix}`.slice(0, 32);
};

/**
 * Maps a verified provider profile onto a panel account.
 *
 * Order of resolution: existing identity link → (optional) verified-email match → brand-new account
 * when the administrator allowed it. A new account always gets the registration role (least
 * privilege) and `disabled = 0`, exactly like self-registration.
 */
export function resolveOauthAccount(profile: IdentityProfile, ip: string): { outcome: OauthOutcome; created: boolean; linkedByEmail: boolean } {
  const existing = queryOne<{ user_id: number; disabled: number; username: string; totp_enabled: number }>(
    `SELECT i.user_id, u.disabled, u.username, u.totp_enabled
     FROM user_identities i JOIN users u ON u.id = i.user_id
     WHERE i.provider = ? AND i.subject = ?`,
    [profile.provider, profile.subject],
  );

  if (existing) {
    if (existing.disabled) {
      throw new ApiException(403, "account_disabled", "This account has been disabled by an administrator.");
    }
    run("UPDATE user_identities SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), email = COALESCE(?, email) WHERE provider = ? AND subject = ?",
      [profile.email, profile.provider, profile.subject]);
    run("UPDATE users SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", [existing.user_id]);
    return {
      outcome: { userId: existing.user_id, username: existing.username, requiresTotp: existing.totp_enabled === 1 },
      created: false,
      linkedByEmail: false,
    };
  }

  const config = readOauthConfig();

  // Link to an existing account only when the provider vouches for the address.
  if (config.linkByEmail && profile.email && profile.emailVerified) {
    const match = queryOne<{ id: number; username: string; disabled: number; totp_enabled: number }>(
      "SELECT id, username, disabled, totp_enabled FROM users WHERE lower(email) = lower(?)", [profile.email],
    );
    if (match) {
      if (match.disabled) {
        throw new ApiException(403, "account_disabled", "This account has been disabled by an administrator.");
      }
      linkIdentity(match.id, profile);
      return {
        outcome: { userId: match.id, username: match.username, requiresTotp: match.totp_enabled === 1 },
        created: false,
        linkedByEmail: true,
      };
    }
  }

  if (!config.allowRegistration) {
    throw new ApiException(
      403, "oauth_no_account",
      "No RSLMC account is linked to this identity, and the administrator has turned off account creation through sign-in providers.",
    );
  }

  // Same role the registration page hands out, so a new account cannot arrive with admin access.
  const registrationRole = (() => {
    const configured = readRegistrationConfig().defaultRole;
    const row = queryOne<{ id: number; name: string }>("SELECT id, name FROM roles WHERE name = ?", [configured])
      ?? queryOne<{ id: number; name: string }>("SELECT id, name FROM roles WHERE name = 'User'")
      ?? queryOne<{ id: number; name: string }>("SELECT id, name FROM roles ORDER BY id DESC LIMIT 1");
    if (!row) throw badRequest("No roles are defined, so a new account cannot be given any access.");
    return row;
  })();

  let username = sanitiseUsername(profile.displayName, profile.provider, profile.subject);
  // Usernames are unique; add entropy rather than failing the sign-in.
  while (queryOne("SELECT id FROM users WHERE lower(username) = lower(?)", [username])) {
    username = `${username.slice(0, 26)}-${randomBytes(2).toString("hex")}`;
  }

  // With email linking switched off the address may already belong to a different account. The
  // identity row keeps it either way, so nothing is lost — the panel account simply has no email
  // until an administrator decides otherwise, instead of the sign-in dying on a UNIQUE constraint.
  const emailTaken = profile.email
    ? queryOne("SELECT id FROM users WHERE lower(email) = lower(?)", [profile.email]) !== null
    : false;

  // A random password hash: the account cannot be signed into with a password until one is set.
  const unusable = `!oauth:${randomUUID()}`;
  const colors = ["#1f6f4a", "#2a5f8a", "#7a4f9c", "#8a5a2a", "#8a2f4a", "#2f7a72"];
  const color = colors[Math.abs(profile.subject.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0)) % colors.length]!;

  const userId = insert(
    `INSERT INTO users (username, email, password_hash, is_root, must_change_password, disabled, avatar_color)
     VALUES (?, ?, ?, 0, 0, 0, ?)`,
    [username, emailTaken ? null : profile.email, unusable, color],
  );
  run("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)", [userId, registrationRole.id]);
  linkIdentity(userId, profile);
  return {
    outcome: { userId, username, requiresTotp: false },
    created: true,
    linkedByEmail: false,
  };
}

function linkIdentity(userId: number, profile: IdentityProfile): void {
  run(
    `INSERT INTO user_identities (user_id, provider, subject, email, display_name, avatar_url, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(provider, subject) DO UPDATE SET
       user_id = excluded.user_id, email = excluded.email,
       display_name = excluded.display_name, avatar_url = excluded.avatar_url,
       last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    [userId, profile.provider, profile.subject, profile.email, profile.displayName, profile.avatarUrl],
  );
}

/* ------------------------------------------------------------------ */
/* Second factor tickets                                               */
/* ------------------------------------------------------------------ */

export function createTicket(userId: number): string {
  const ticket = randomBytes(24).toString("base64url");
  run("DELETE FROM oauth_tickets WHERE expires_at < ?", [new Date().toISOString()]);
  insert("INSERT INTO oauth_tickets (ticket, user_id, expires_at) VALUES (?, ?, ?)", [
    ticket, userId, new Date(Date.now() + TICKET_TTL_MS).toISOString(),
  ]);
  return ticket;
}

export function consumeTicket(ticket: string): number | null {
  if (!ticket) return null;
  const row = queryOne<{ user_id: number; expires_at: string }>(
    "SELECT user_id, expires_at FROM oauth_tickets WHERE ticket = ?", [ticket],
  );
  run("DELETE FROM oauth_tickets WHERE ticket = ?", [ticket]);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row.user_id;
}

/* ------------------------------------------------------------------ */
/* Admin view                                                          */
/* ------------------------------------------------------------------ */

export function identitiesForUser(userId: number) {
  return query(
    "SELECT provider, subject, email, display_name, created_at, last_login_at FROM user_identities WHERE user_id = ? ORDER BY provider",
    [userId],
  ).map((row: any) => ({
    provider: row.provider,
    subject: row.subject,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  }));
}

export function oauthAdminView() {
  const config = readOauthConfig();
  return {
    ...config,
    // Secrets are never echoed; only whether one is stored (already modelled by secretSet).
    identities: queryOne<{ c: number }>("SELECT COUNT(*) AS c FROM user_identities")?.c ?? 0,
    lastLogins: queryOne<{ c: number }>(
      "SELECT COUNT(*) AS c FROM audit_events WHERE action = 'auth.oauth_login' AND ts > ?",
      [new Date(Date.now() - 7 * 86400_000).toISOString()],
    )?.c ?? 0,
  };
}

export function unlinkIdentity(userId: number, provider: string): void {
  const linked = query<{ provider: string }>("SELECT provider FROM user_identities WHERE user_id = ?", [userId]);
  if (!linked.some((row) => row.provider === provider)) {
    throw badRequest("That provider is not linked to this account.");
  }
  // Keep at least one way in: an account created by OAuth has no usable password.
  const user = queryOne<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", [userId]);
  const hasPassword = Boolean(user && !user.password_hash.startsWith("!oauth:"));
  const remaining = linked.filter((row) => row.provider !== provider).length;
  if (remaining === 0 && !hasPassword) {
    throw badRequest("This would leave the account with no way to sign in. Set a password first.");
  }
  run("DELETE FROM user_identities WHERE user_id = ? AND provider = ?", [userId, provider]);
}

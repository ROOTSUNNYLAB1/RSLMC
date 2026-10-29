import { randomBytes, createHash } from "node:crypto";
import { queryOne, query, run, insert } from "../database";
import { unauthorized, forbidden, ApiException } from "../shared/http";
import type { Permission } from "../shared/permissions";
import type { UserPublic } from "../shared/types";
import { hashPassword, verifyPassword } from "../security/passwords";
import { MODE } from "../shared/config";
import { DEFAULT_THEME } from "../shared/themes";

export const SESSION_COOKIE = "rslmc_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

interface UserRow {
  id: number;
  username: string;
  email: string | null;
  password_hash: string;
  is_root: number;
  must_change_password: number;
  totp_secret: string | null;
  totp_enabled: number;
  totp_recovery: string | null;
  disabled: number;
  avatar_color: string;
  avatar_file: string | null;
  avatar_version: number;
  theme: string;
  failed_attempts: number;
  locked_until: string | null;
  last_login_at: string | null;
  created_at: string;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function permissionsForUser(userId: number, isRoot: boolean): string[] {
  if (isRoot) return ["*"];
  const rows = query<{ permission: string }>(
    `SELECT DISTINCT rp.permission FROM role_permissions rp
     JOIN user_roles ur ON ur.role_id = rp.role_id
     WHERE ur.user_id = ?`,
    [userId],
  );
  return rows.map((r) => r.permission);
}

export function rolesForUser(userId: number): string[] {
  return query<{ name: string }>(
    `SELECT r.name FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ? ORDER BY r.name`,
    [userId],
  ).map((r) => r.name);
}

export function publicUser(row: UserRow): UserPublic {
  const permissions = permissionsForUser(row.id, row.is_root === 1);
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    isRoot: row.is_root === 1,
    mustChangePassword: row.must_change_password === 1,
    totpEnabled: row.totp_enabled === 1,
    disabled: row.disabled === 1,
    roles: rolesForUser(row.id),
    permissions,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    avatarColor: row.avatar_color,
    avatarUrl: row.avatar_file ? `/api/users/${row.id}/avatar?v=${row.avatar_version ?? 0}` : null,
    theme: row.theme || DEFAULT_THEME,
  };
}

export function findUserById(id: number): UserRow | null {
  return queryOne<UserRow>("SELECT * FROM users WHERE id = ?", [id]);
}

export function findUserByUsername(username: string): UserRow | null {
  return queryOne<UserRow>("SELECT * FROM users WHERE lower(username) = lower(?)", [username]);
}

export interface LoginResult {
  token: string;
  csrfToken: string;
  user: UserPublic;
  expiresAt: string;
  requiresTotp: boolean;
}

export class AuthError extends ApiException {}

export async function login(
  username: string,
  password: string,
  totp: string | undefined,
  meta: { ip: string; userAgent: string },
): Promise<LoginResult> {
  const user = findUserByUsername(username);
  // Constant-ish work for unknown users to avoid trivial username enumeration by timing.
  if (!user) {
    await hashPassword("rslmc-dummy-password-check");
    throw new AuthError(401, "invalid_credentials", "Invalid username or password");
  }
  if (user.disabled) throw new AuthError(403, "account_disabled", "This account has been disabled");
  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    throw new AuthError(429, "account_locked", "Too many failed attempts. Try again later.");
  }
  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    const attempts = user.failed_attempts + 1;
    const lockUntil = attempts >= 8 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
    run("UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?", [attempts, lockUntil, user.id]);
    throw new AuthError(401, "invalid_credentials", "Invalid username or password");
  }
  if (user.totp_enabled === 1) {
    if (!totp) throw new AuthError(401, "totp_required", "Two-factor authentication code required");
    const { verifyTotp } = await import("../security/totp");
    if (!verifyTotp(user.totp_secret ?? "", totp)) {
      throw new AuthError(401, "invalid_totp", "Invalid two-factor authentication code");
    }
  }

  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  insert(
    "INSERT INTO sessions (id, user_id, csrf_token, ip, user_agent, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    [hashToken(token), user.id, csrfToken, meta.ip, meta.userAgent.slice(0, 250), expiresAt],
  );
  run(
    "UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
    [user.id],
  );
  const refreshed = findUserById(user.id)!;
  return { token, csrfToken, user: publicUser(refreshed), expiresAt, requiresTotp: false };
}

/**
 * Issues a session for an account that was authenticated by something other than a password
 * (single sign-on, or a second-factor completion). The token/CSRF handling is identical to `login()`,
 * so an OAuth session is not a weaker session.
 */
export function createSessionForUser(
  user: { id: number },
  meta: { ip: string; userAgent: string },
): { token: string; csrfToken: string; expiresAt: string } {
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  insert(
    "INSERT INTO sessions (id, user_id, csrf_token, ip, user_agent, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    [hashToken(token), user.id, csrfToken, meta.ip, meta.userAgent.slice(0, 250), expiresAt],
  );
  run(
    "UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
    [user.id],
  );
  return { token, csrfToken, expiresAt };
}

export function validateSession(token: string): { user: UserPublic; sessionId: string; csrfToken: string } | null {
  if (!token) return null;
  const id = hashToken(token);
  const row = queryOne<{ id: string; user_id: number; csrf_token: string; expires_at: string }>(
    "SELECT id, user_id, csrf_token, expires_at FROM sessions WHERE id = ?",
    [id],
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    run("DELETE FROM sessions WHERE id = ?", [id]);
    return null;
  }
  const user = findUserById(row.user_id);
  if (!user || user.disabled) return null;
  run("UPDATE sessions SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", [id]);
  return { user: publicUser(user), sessionId: id, csrfToken: row.csrf_token };
}

export function destroySession(token: string): void {
  run("DELETE FROM sessions WHERE id = ?", [hashToken(token)]);
}

export function destroyAllSessionsForUser(userId: number, exceptSessionId?: string): void {
  if (exceptSessionId) run("DELETE FROM sessions WHERE user_id = ? AND id != ?", [userId, exceptSessionId]);
  else run("DELETE FROM sessions WHERE user_id = ?", [userId]);
}

/**
 * True when this request reached the panel over TLS — either directly (`https://…`) or through a
 * reverse proxy that sets `X-Forwarded-Proto: https`.
 *
 * The cookie's `Secure` flag used to follow `RSLMC_MODE`, so a production-mode panel served over
 * plain HTTP (e.g. `http://host:3000` on a VPS) handed the browser a `Secure` session cookie that
 * it immediately discarded: login "succeeded" and every following `/api/auth/me` returned 401.
 * `RSLMC_COOKIE_SECURE=always|never` overrides the detection for unusual deployments.
 */
export function isSecureRequest(req?: Request): boolean {
  const override = (process.env.RSLMC_COOKIE_SECURE ?? "").trim().toLowerCase();
  if (override === "always" || override === "true" || override === "1") return true;
  if (override === "never" || override === "false" || override === "0") return false;
  if (!req) return MODE === "production";
  try {
    if (new URL(req.url).protocol === "https:") return true;
  } catch { /* malformed URL — fall through to the header check */ }
  const forwarded = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  return forwarded === "https";
}

export function sessionCookieOptions(req?: Request) {
  return {
    maxAge: SESSION_TTL_MS / 1000,
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: "Lax" as const,
    path: "/",
  };
}

/* ------------------------------------------------------------------ */
/* Authorization helpers                                               */
/* ------------------------------------------------------------------ */

export function hasPermission(user: UserPublic | undefined, permission: Permission | Permission[]): boolean {
  if (!user) return false;
  if (user.isRoot || user.permissions.includes("*")) return true;
  const needed = Array.isArray(permission) ? permission : [permission];
  return needed.some((p) => user.permissions.includes(p));
}

export function requirePermission(user: UserPublic | undefined, permission: Permission | Permission[]): void {
  if (!user) throw unauthorized();
  if (!hasPermission(user, permission)) throw forbidden();
}

/** A user may access a server when they are root or explicitly own/have access to it. */
export function canAccessServer(user: UserPublic | undefined, serverId: number): boolean {
  if (!user) return false;
  if (!hasPermission(user, "server.view")) return false;
  if (user.isRoot) return true;
  const server = queryOne<{ owner_id: number }>("SELECT owner_id FROM servers WHERE id = ?", [serverId]);
  if (!server) return false;
  if (server.owner_id === user.id) return true;
  const shared = queryOne(
    "SELECT 1 AS ok FROM server_subusers WHERE server_id = ? AND user_id = ?",
    [serverId, user.id],
  );
  return Boolean(shared);
}

export function requireServerAccess(user: UserPublic | undefined, serverId: number, permission?: Permission | Permission[]): void {
  if (!user) throw unauthorized();
  if (permission) requirePermission(user, permission);
  if (!canAccessServer(user, serverId)) throw new AuthError(404, "not_found", "Server not found");
}

export async function changePassword(
  userId: number,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = findUserById(userId);
  if (!user) throw unauthorized();
  const ok = await verifyPassword(currentPassword, user.password_hash);
  if (!ok) throw new AuthError(400, "invalid_password", "Current password is incorrect");
  const { assertPasswordPolicy } = await import("../security/passwords");
  assertPasswordPolicy(newPassword);
  const same = await verifyPassword(newPassword, user.password_hash);
  if (same) throw new AuthError(400, "password_reuse", "New password must differ from the current password");
  const hash = await hashPassword(newPassword);
  run(
    "UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
    [hash, userId],
  );
  run("DELETE FROM notifications WHERE user_id = ? AND kind = 'password_rotation'", [userId]);
}

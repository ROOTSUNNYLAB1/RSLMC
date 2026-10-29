import { getSetting, setSetting, query, queryOne, insert, run } from "../database";
import { hashPassword, checkPasswordPolicy } from "../security/passwords";
import { badRequest, ApiException } from "../shared/http";
import { needsSetup } from "./bootstrap";
import { notify } from "./notifications";

/**
 * Self-registration.
 *
 * Off by default, on purpose: an RSLMC panel can start, stop and delete servers, so letting the
 * world create accounts has to be an explicit decision an administrator makes in the UI. Everything
 * here is additive — nothing about the existing bootstrap/admin login path changes.
 */

export interface RegistrationConfig {
  enabled: boolean;
  requireCode: boolean;
  defaultRole: string;
  /** The invite code itself is write-only; the API only ever says whether one is configured. */
  codeSet: boolean;
}

export interface RegistrationPatch {
  enabled?: boolean;
  requireCode?: boolean;
  defaultRole?: string;
  /** `null` clears the stored code, `undefined` leaves it untouched. */
  inviteCode?: string | null;
}

const KEYS = {
  enabled: "registration.enabled",
  requireCode: "registration.requireCode",
  defaultRole: "registration.defaultRole",
  inviteCode: "registration.inviteCode",
} as const;

const truthy = (value: string | null, fallback: boolean): boolean =>
  value === null || value === "" ? fallback : value === "1" || value === "true";

export function inviteCode(): string | null {
  const code = getSetting(KEYS.inviteCode, "") ?? "";
  return code.length > 0 ? code : null;
}

export function readRegistrationConfig(): RegistrationConfig {
  return {
    enabled: truthy(getSetting(KEYS.enabled, "0"), false),
    requireCode: truthy(getSetting(KEYS.requireCode, "0"), false),
    defaultRole: getSetting(KEYS.defaultRole, "User") ?? "User",
    codeSet: inviteCode() !== null,
  };
}

/** The role new accounts receive. Falls back to the least-privileged role that exists. */
export function defaultRoleRow(): { id: number; name: string } {
  const configured = readRegistrationConfig().defaultRole;
  const wanted = queryOne<{ id: number; name: string }>("SELECT id, name FROM roles WHERE name = ?", [configured]);
  if (wanted) return wanted;
  for (const fallback of ["User", "Viewer"]) {
    const row = queryOne<{ id: number; name: string }>("SELECT id, name FROM roles WHERE name = ?", [fallback]);
    if (row) return row;
  }
  const smallest = queryOne<{ id: number; name: string }>(
    `SELECT r.id, r.name FROM roles r
     LEFT JOIN role_permissions rp ON rp.role_id = r.id
     GROUP BY r.id ORDER BY COUNT(rp.permission) ASC, r.id ASC LIMIT 1`,
  );
  if (!smallest) throw badRequest("No roles are defined, so a new account cannot be given any access.");
  return smallest;
}

export function writeRegistrationConfig(patch: RegistrationPatch): RegistrationConfig {
  if (patch.enabled !== undefined) setSetting(KEYS.enabled, patch.enabled ? "1" : "0");
  if (patch.requireCode !== undefined) setSetting(KEYS.requireCode, patch.requireCode ? "1" : "0");
  if (patch.defaultRole !== undefined) {
    const role = queryOne<{ id: number }>("SELECT id FROM roles WHERE name = ?", [patch.defaultRole]);
    if (!role) throw badRequest(`There is no role called “${patch.defaultRole}”.`);
    setSetting(KEYS.defaultRole, patch.defaultRole);
  }
  if (patch.inviteCode !== undefined) {
    const code = (patch.inviteCode ?? "").trim();
    if (code.length > 0 && code.length < 6) throw badRequest("The sign-up code must be at least 6 characters long.");
    if (code.length > 128) throw badRequest("The sign-up code must be shorter than 128 characters.");
    setSetting(KEYS.inviteCode, code, true);
  }
  return readRegistrationConfig();
}

/** True only when registration is actually usable right now. */
export function registrationOpen(): { open: boolean; reason: string | null } {
  if (needsSetup()) return { open: false, reason: "The panel still has to create its first administrator." };
  const config = readRegistrationConfig();
  if (!config.enabled) return { open: false, reason: "Self-registration is disabled by the administrator." };
  return { open: true, reason: null };
}

export interface PublicRegistrationInfo {
  enabled: boolean;
  requireCode: boolean;
  defaultRole: string;
  message: string | null;
  passwordPolicy: { minLength: number; requires: string[] };
}

/**
 * What an anonymous visitor is allowed to know. Deliberately small: no invite code, no user counts,
 * no role permissions — just enough to render the form honestly.
 */
export function publicRegistrationInfo(): PublicRegistrationInfo {
  const open = registrationOpen();
  const config = readRegistrationConfig();
  return {
    enabled: open.open,
    requireCode: open.open && config.requireCode,
    defaultRole: config.defaultRole,
    message: open.reason,
    passwordPolicy: {
      minLength: 10,
      requires: [
        "At least 10 characters",
        "An uppercase and a lowercase letter",
        "A number",
        "A symbol",
      ],
    },
  };
}

const RESERVED_USERNAMES = new Set([
  "admin", "administrator", "root", "system", "rslmc", "panel", "console", "server", "support", "owner",
]);

const AVATAR_COLORS = ["#1f6f4a", "#2a5f8a", "#7a4f9c", "#8a5a2a", "#8a2f4a", "#2f7a72"];

function avatarColorFor(username: string): string {
  let hash = 0;
  for (const char of username.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export interface RegisterInput {
  username: string;
  password: string;
  email?: string;
  code?: string;
  ip: string;
}

export interface RegisterResult {
  userId: number;
  username: string;
  role: string;
  message: string;
}

export async function registerAccount(input: RegisterInput): Promise<RegisterResult> {
  const open = registrationOpen();
  if (!open.open) throw new ApiException(403, "registration_closed", open.reason ?? "Registration is closed.");

  const config = readRegistrationConfig();
  const username = String(input.username ?? "").trim();
  const email = (input.email ?? "").trim();
  const password = String(input.password ?? "");

  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
    throw badRequest("Usernames must be 3–32 characters and may only contain letters, numbers, dots, dashes and underscores.");
  }
  if (RESERVED_USERNAMES.has(username.toLowerCase())) {
    throw badRequest("That username is reserved. Please choose another one.");
  }
  if (email.length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw badRequest("That email address does not look valid.");
  }
  if (config.requireCode) {
    const expected = inviteCode();
    const supplied = String(input.code ?? "").trim();
    // Constant-time-ish comparison; the code is short and rate limiting covers the rest.
    if (!expected || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new ApiException(403, "invalid_invite_code", "That sign-up code is not valid.");
    }
  }

  const policy = checkPasswordPolicy(password);
  if (!policy.ok) throw badRequest("Password does not meet the security requirements.", policy.problems);

  if (queryOne("SELECT id FROM users WHERE lower(username) = lower(?)", [username])) {
    throw badRequest("That username is already taken.");
  }
  if (email && queryOne("SELECT id FROM users WHERE lower(email) = lower(?)", [email])) {
    throw badRequest("An account already uses that email address.");
  }

  const role = defaultRoleRow();
  // Accounts are active immediately: registration is only open when an administrator said so, and
  // the role decides what the account can reach. Servers still have to be allocated to it.
  const userId = insert(
    `INSERT INTO users (username, email, password_hash, is_root, must_change_password, disabled, avatar_color)
     VALUES (?, ?, ?, 0, 0, 0, ?)`,
    [username, email || null, await hashPassword(password), avatarColorFor(username)],
  );
  run("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)", [userId, role.id]);

  // Tell the administrators somebody new joined, without making them approve anything.
  for (const admin of query<{ id: number }>("SELECT id FROM users WHERE is_root = 1 AND disabled = 0")) {
    notify({
      userId: admin.id,
      severity: "info",
      kind: "user_registration",
      title: `New account registered: ${username}`,
      body: `${username} registered from ${input.ip} with the ${role.name} role. Give it a server under Administration → Users → Servers.`,
      link: "/admin/users",
    });
  }

  return {
    userId,
    username,
    role: role.name,
    message: `Account created. Your ${role.name} account has no servers yet — an administrator has to allocate one to you.`,
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

/** Admin-side summary: config plus the numbers an operator needs to decide. */
export function registrationAdminView() {
  const config = readRegistrationConfig();
  const open = registrationOpen();
  return {
    ...config,
    open: open.open,
    closedReason: open.reason,
    defaultRole: defaultRoleRow().name,
    createdLast7Days: queryOne<{ c: number }>(
      "SELECT COUNT(*) AS c FROM users WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')",
    )?.c ?? 0,
  };
}

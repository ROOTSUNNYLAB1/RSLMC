import {
  appendFileSync, chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { getSetting, setSetting } from "../database";

/*
 * The service account that app servers run as.
 *
 * A Minecraft server has always run as whoever started the panel, which on a VPS is usually root — so a
 * plugin, a mod, or anything that shells out through the console has root's reach. For the non-Minecraft
 * runtimes (Python, Node.js) the panel therefore refuses to use the panel's own account and gives them
 * their own: `rslmc-nonroot`, a normal account with a password, **no sudo**, and ownership of nothing
 * except the server directories it is pointed at.
 *
 * This is enforced by the kernel (`setuid` on spawn), not by a promise in the UI. Everything here reports
 * what it *measured*: whether the account exists, its real uid/gid, whether it can escalate, and whether
 * the panel is privileged enough to switch to it at all.
 */

export const SERVICE_USER = "rslmc-nonroot";
const PASSWORD_SETTING = "nonroot.password";
const CREATED_SETTING = "nonroot.createdAt";

export interface ServiceAccountState {
  /** The account name every app server runs as. */
  user: string;
  exists: boolean;
  uid: number | null;
  gid: number | null;
  groups: string[];
  /** True when this account can escalate with sudo — must always be false. */
  sudo: boolean;
  home: string | null;
  /** True when a password has been set for the account (hash present in /etc/shadow). */
  passwordSet: boolean;
  createdAt: string | null;
  /**
   * True when the panel itself is privileged enough to start a process as another user. Without this
   * there is no non-root isolation, and the panel says so instead of pretending.
   */
  canIsolate: boolean;
  /** Why isolation is impossible here, when it is. */
  reason: string | null;
  platform: string;
}

function runCommand(argv: string[], timeoutMs = 20_000): { ok: boolean; out: string; code: number } {
  try {
    const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: timeoutMs });
    return {
      ok: result.exitCode === 0,
      out: `${result.stdout.toString()}${result.stderr.toString()}`.trim(),
      code: result.exitCode ?? -1,
    };
  } catch (error) {
    return { ok: false, out: error instanceof Error ? error.message : String(error), code: -1 };
  }
}

/** True when the panel can `setuid` — i.e. it is root, or Windows (where the helper handles it). */
export function panelCanSwitchUser(): boolean {
  if (process.platform === "win32") return false;
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  return uid === 0;
}

/** One `name:x:uid:gid:...` line, or null. */
function passwdEntry(name: string): string[] | null {
  try {
    for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
      const parts = line.split(":");
      if (parts[0] === name && parts.length >= 4) return parts;
    }
  } catch { /* no /etc/passwd: not a Unix host */ }
  return null;
}

/**
 * The account's real uid/gid and groups.
 *
 * Read from `/etc/passwd` and `/etc/group` rather than shelling out to `id`: a minimal container image
 * (or a distro that trimmed coreutils) has no `id`, no `useradd` and no `chpasswd`, and a panel that
 * only knew how to call them would refuse to isolate anything on such a host for no good reason.
 */
function lookupAccount(name: string): { exists: boolean; uid: number | null; gid: number | null; groups: string[] } {
  const entry = passwdEntry(name);
  if (!entry) return { exists: false, uid: null, gid: null, groups: [] };
  const uid = Number(entry[2]);
  const gid = Number(entry[3]);
  const groups: string[] = [];
  try {
    for (const line of readFileSync("/etc/group", "utf8").split("\n")) {
      const parts = line.split(":");
      if (parts.length < 4) continue;
      const members = (parts[3] ?? "").split(",").map((member) => member.trim());
      // A group counts either because the account is a member, or because it is the account's primary gid.
      if (members.includes(name) || (parts[0] === name && Number(parts[2]) === gid)) groups.push(parts[0]!);
    }
  } catch { /* no /etc/group */ }
  return { exists: true, uid: Number.isInteger(uid) ? uid : null, gid: Number.isInteger(gid) ? gid : null, groups };
}

function homeFor(name: string): string | null {
  try {
    for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
      const parts = line.split(":");
      if (parts[0] === name) return parts[5] ?? null;
    }
  } catch { /* not Linux */ }
  return null;
}

function passwordIsSet(name: string): boolean {
  // /etc/shadow is root-only. Reading it is not a security decision here — it is a status check the
  // panel already has the right to make, because it created the account.
  try {
    for (const line of readFileSync("/etc/shadow", "utf8").split("\n")) {
      const parts = line.split(":");
      if (parts[0] === name) return Boolean(parts[1]) && !/^[!*]/.test(parts[1]!);
    }
  } catch { /* no access: fall back to the stored flag */ }
  return Boolean(getSetting(PASSWORD_SETTING, null));
}

/** Everything the UI needs to tell the truth about the service account. */
export function serviceAccountState(): ServiceAccountState {
  const platform = process.platform;
  if (platform === "win32") {
    return {
      user: SERVICE_USER, exists: false, uid: null, gid: null, groups: [], sudo: false, home: null,
      passwordSet: false, createdAt: getSetting(CREATED_SETTING, null), canIsolate: false,
      reason: "Windows has no equivalent of a dedicated unprivileged service account for spawned processes in this build; "
        + "app servers run under the panel's own account. Docker runtime gives real isolation on Windows.",
      platform,
    };
  }

  const account = lookupAccount(SERVICE_USER);
  const privileged = panelCanSwitchUser();
  /*
   * Sudo is decided by evidence, not by hope: membership of a known sudo group, or a dedicated
   * sudoers.d file. Both are removed by `ensureServiceAccount`.
   */
  const sudoCapable = account.exists
    && (["sudo", "wheel", "admin"].some((group) => account.groups.includes(group))
      || existsSync(`/etc/sudoers.d/${SERVICE_USER}`));

  return {
    user: SERVICE_USER,
    exists: account.exists,
    uid: account.uid,
    gid: account.gid,
    groups: account.groups,
    sudo: sudoCapable,
    home: account.exists ? homeFor(SERVICE_USER) : null,
    passwordSet: account.exists ? passwordIsSet(SERVICE_USER) : false,
    createdAt: getSetting(CREATED_SETTING, null),
    canIsolate: privileged,
    reason: privileged ? null
      : "The panel is not running as root, so it cannot switch to another account. Start the panel as root "
        + "(it drops privileges for app servers itself), or use the Docker runtime, which isolates without needing that.",
    platform,
  };
}

export interface EnsureResult {
  state: ServiceAccountState;
  /** The generated password, returned exactly once — when the account was created by this call. */
  password?: string;
  created: boolean;
  notes: string[];
}

/* ------------------------------------------------------------------ */
/* Creating the account without assuming which tools exist             */
/* ------------------------------------------------------------------ */

/** Appends one line to a root-owned file, creating it if needed. */
function appendLine(path: string, line: string): void {
  appendFileSync(path, line.endsWith("\n") ? line : `${line}\n`, { mode: 0o644 });
}

function nextFreeId(kind: "uid" | "gid"): number {
  const file = kind === "uid" ? "/etc/passwd" : "/etc/group";
  const column = kind === "uid" ? 2 : 2;
  let highest = 1000;
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const parts = line.split(":");
      const value = Number(parts[column]);
      if (Number.isInteger(value) && value > highest && value < 60000) highest = value;
    }
  } catch { /* fall through with the floor */ }
  return highest + 1;
}

/**
 * Creates the system account.
 *
 * `useradd` is the normal path, but it is not universal: slim container images ship without shadow
 * utilities entirely. So the fallbacks go in order of how much they delegate to the system —
 * `useradd`, then the Alpine/BusyBox `adduser`, then writing the three files a Unix account really
 * consists of. The last path is used only as root, which is exactly the case where the panel is allowed
 * to touch them, and it reports which path it took.
 */
function createSystemUser(): { ok: boolean; method: string; message: string } {
  if (passwdEntry(SERVICE_USER)) return { ok: true, method: "exists", message: "already present" };

  const attempts: { method: string; argv: string[] }[] = [
    { method: "useradd", argv: ["useradd", "--create-home", "--shell", "/bin/bash", "--comment", "RSLMC app service account (no sudo)", SERVICE_USER] },
    { method: "adduser", argv: ["adduser", "--disabled-password", "--gecos", "RSLMC app service account (no sudo)", SERVICE_USER] },
    { method: "adduser-busybox", argv: ["adduser", "-D", "-s", "/bin/bash", "-D", "-H", SERVICE_USER] },
    { method: "busybox", argv: ["busybox", "adduser", "-D", "-s", "/bin/bash", SERVICE_USER] },
  ];
  for (const attempt of attempts) {
    const result = runCommand(attempt.argv);
    if (result.ok && passwdEntry(SERVICE_USER)) return { ok: true, method: attempt.method, message: result.out };
    // "not found" means keep trying; a real refusal from an existing tool is also worth trying the next one.
  }

  /* Last resort: write the account files directly. */
  try {
    const gid = nextFreeId("gid");
    const uid = nextFreeId("uid");
    const home = `/home/${SERVICE_USER}`;
    if (!readFileSync("/etc/group", "utf8").split("\n").some((line) => line.split(":")[0] === SERVICE_USER)) {
      appendLine("/etc/group", `${SERVICE_USER}:x:${gid}:`);
    }
    appendLine("/etc/passwd", `${SERVICE_USER}:x:${uid}:${gid}:RSLMC app service account (no sudo):${home}:/bin/bash`);
    mkdirSync(home, { recursive: true, mode: 0o755 });
    chownSync(home, uid, gid);
    return { ok: true, method: "passwd-file", message: `wrote uid ${uid} / gid ${gid}` };
  } catch (error) {
    return { ok: false, method: "none", message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Sets the account's password.
 *
 * `chpasswd` when it exists; otherwise a crypt(3) hash from `openssl passwd -6` written straight into
 * `/etc/shadow` (the file the login system actually reads). When neither is available the account is
 * left without a password and the caller is told so — a "password set" tick that nobody can log in with
 * would be a lie in the one place the panel promised a password.
 */
function setSystemPassword(password: string): { ok: boolean; method: string; message: string } {
  try {
    const viaChpasswd = Bun.spawnSync(["chpasswd"], { stdin: Buffer.from(`${SERVICE_USER}:${password}\n`) });
    if (viaChpasswd.exitCode === 0 && passwordIsSet(SERVICE_USER)) return { ok: true, method: "chpasswd", message: "" };
  } catch {
    // No chpasswd on this host (slim images): fall through to the hash route below.
  }

  const hashed = runCommand(["openssl", "passwd", "-6", password]);
  if (!hashed.ok || !hashed.out.startsWith("$6$")) {
    return { ok: false, method: "none", message: "no chpasswd and no openssl on this host, so a password could not be set" };
  }
  try {
    const lines = readFileSync("/etc/shadow", "utf8").split("\n");
    const index = lines.findIndex((line) => line.split(":")[0] === SERVICE_USER);
    const fields = (index >= 0 ? lines[index]!.split(":") : [SERVICE_USER, "", "0", "99999", "7", "", "", "", ""]);
    fields[1] = hashed.out.trim();
    if (index >= 0) lines[index] = fields.join(":");
    else lines.splice(lines.length - 1, 0, fields.join(":"));
    /*
     * Write through a temporary file and rename: /etc/shadow is read by every login, and a partially
     * written line would lock every account on the box out, not just this one.
     */
    const tmp = `/etc/shadow.rslmc-${process.pid}`;
    writeFileSync(tmp, lines.join("\n"), { mode: 0o600 });
    renameSync(tmp, "/etc/shadow");
    return { ok: passwordIsSet(SERVICE_USER), method: "shadow-file", message: "" };
  } catch (error) {
    return { ok: false, method: "shadow-file", message: error instanceof Error ? error.message : String(error) };
  }
}

/** A readable but strong password: 24 chars from an unambiguous alphabet. */
function generatePassword(): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(24);
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

/**
 * Creates (or repairs) the service account.
 *
 * Repairs matter as much as creation: an account that someone has since added to `sudo`, or whose
 * password was never set, is not what the isolation claims. Both are fixed here, and every action is
 * reported in `notes` so the UI can show what changed.
 */
export function ensureServiceAccount(): EnsureResult {
  const notes: string[] = [];
  const before = serviceAccountState();
  if (before.platform === "win32") return { state: before, created: false, notes: [before.reason ?? ""] };

  if (!panelCanSwitchUser()) {
    return { state: before, created: false, notes: [before.reason ?? "The panel is not root."] };
  }

  let created = false;
  let password: string | undefined;

  if (!before.exists) {
    const result = createSystemUser();
    if (!result.ok) throw new Error(`Could not create ${SERVICE_USER}: ${result.message}`);
    created = true;
    notes.push(`Created the ${SERVICE_USER} account with its own home directory (via ${result.method}).`);
  }

  /* A password is required by the request and useful for SFTP; set it once, never printed again. */
  if (!passwordIsSet(SERVICE_USER)) {
    const candidate = generatePassword();
    const result = setSystemPassword(candidate);
    if (result.ok) {
      password = candidate;
      setSetting(PASSWORD_SETTING, candidate, true);
      notes.push(`Set a password for ${SERVICE_USER} (via ${result.method}). It is shown once in the panel and stored hashed on the system.`);
    } else {
      // Not fatal: the servers still run isolated. But the account has no password, and that is said out loud.
      notes.push(`Password NOT set for ${SERVICE_USER}: ${result.message}. The account still cannot escalate; use Docker if you need a real container user instead.`);
    }
  }

  /* No sudo, ever. If somebody granted it later, take it away and say so. */
  const afterCreate = lookupAccount(SERVICE_USER);
  const sudoGroups = ["sudo", "wheel", "admin"].filter((group) => afterCreate.groups.includes(group));
  for (const group of sudoGroups) {
    const removal = runCommand(["gpasswd", "-d", SERVICE_USER, group]);
    if (!removal.ok) {
      // No gpasswd (slim images): rewrite the group's member list directly.
      try {
        const lines = readFileSync("/etc/group", "utf8").split("\n").map((line) => {
          const parts = line.split(":");
          if (parts[0] !== group || parts.length < 4) return line;
          parts[3] = (parts[3] ?? "").split(",").filter((member) => member && member !== SERVICE_USER).join(",");
          return parts.join(":");
        });
        writeFileSync("/etc/group", lines.join("\n"));
      } catch { /* reported below */ }
    }
    notes.push(`Removed ${SERVICE_USER} from the "${group}" group — app servers must not be able to escalate.`);
  }
  if (sudoGroups.length > 0) {
    // A group change only applies to new sessions, which is what every server start is.
    notes.push("The account keeps running servers only after the group change; restart them to pick it up.");
  }
  if (existsSync(`/etc/sudoers.d/${SERVICE_USER}`)) {
    const drop = runCommand(["rm", "-f", `/etc/sudoers.d/${SERVICE_USER}`]);
    if (drop.ok) notes.push(`Removed /etc/sudoers.d/${SERVICE_USER}.`);
  }

  if (created) setSetting(CREATED_SETTING, new Date().toISOString());

  const state = serviceAccountState();
  if (state.sudo) notes.push(`WARNING: ${SERVICE_USER} can still escalate. Remove its sudo rights before relying on isolation.`);
  return { state, created, password, notes };
}

/**
 * Makes the path *reachable* by the service account.
 *
 * A Unix process can only reach a file if **every** directory on the way grants it execute permission.
 * The panel's data directory is normally created 0750 (or 0700 on a hardened host), and a data root under
 * `/home/<user>` inherits that user's 0700 — so the interpreter is perfectly installed and still
 * "permission denied" at spawn time.
 *
 * The fix is the narrowest one that works: add execute-for-others to the directories on the path only
 * (never read, so nobody can list them), and report every permission that was widened. If the panel is
 * not root it cannot widen anything, and says which directory blocks instead of failing at spawn with a
 * bare EACCES.
 */
export function ensureTraversable(path: string): { ok: boolean; widened: string[]; blocked: string[] } {
  const widened: string[] = [];
  const blocked: string[] = [];
  if (process.platform === "win32") return { ok: true, widened, blocked };
  const privileged = panelCanSwitchUser();

  let current = path;
  const seen = new Set<string>();
  while (current && current !== "/" && !seen.has(current)) {
    seen.add(current);
    try {
      const stat = statSync(current);
      if (!stat.isDirectory()) { current = dirname(current); continue; }
      if ((stat.mode & 0o001) === 0) {
        if (privileged) {
          chmodSync(current, stat.mode | 0o111);
          widened.push(current);
        } else {
          blocked.push(current);
        }
      }
    } catch {
      blocked.push(current);
    }
    current = dirname(current);
  }
  return { ok: blocked.length === 0, widened, blocked };
}

/**
 * Gives the service account ownership of one server directory.
 *
 * Recursive and idempotent. The interpreter installs stay root-owned and world-readable on purpose: a
 * server that could write into a shared Python install could break every other server using it.
 */
export function handOverDirectory(directory: string, state = serviceAccountState()): { changed: number; skipped: number } {
  if (!state.exists || state.uid === null || state.gid === null) return { changed: 0, skipped: 0 };
  if (!existsSync(directory)) return { changed: 0, skipped: 0 };
  // The directory is useless to the account if it cannot be reached at all.
  ensureTraversable(directory);
  let changed = 0;
  let skipped = 0;
  const walk = (path: string) => {
    let stat;
    try { stat = lstatSync(path); } catch { skipped += 1; return; }
    if (stat.isSymbolicLink()) { skipped += 1; return; }
    try {
      if (stat.uid !== state.uid || stat.gid !== state.gid) { chownSync(path, state.uid!, state.gid!); changed += 1; }
    } catch { skipped += 1; }
    if (stat.isDirectory()) {
      try { for (const entry of readdirSync(path)) walk(join(path, entry)); } catch { skipped += 1; }
    }
  };
  walk(directory);
  return { changed, skipped };
}

/**
 * The spawn options that put a process into the service account.
 *
 * Returns `null` when the panel cannot switch users — the caller must then decide whether to refuse the
 * start (app servers do) rather than silently running as root.
 */
export function serviceSpawnIdentity(state = serviceAccountState()): { uid: number; gid: number; user: string } | null {
  if (!state.exists || state.uid === null || state.gid === null) return null;
  if (!panelCanSwitchUser()) return null;
  return { uid: state.uid, gid: state.gid, user: state.user };
}

/** Environment for a process that must not be able to reach the panel's own files. */
export function serviceEnvironment(home: string | null, extraPath: string[] = []): Record<string, string> {
  const path = [...extraPath, "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  return {
    HOME: home ?? `/home/${SERVICE_USER}`,
    USER: SERVICE_USER,
    LOGNAME: SERVICE_USER,
    SHELL: "/bin/bash",
    PATH: path,
    // A service account must not inherit the panel's data-location hints.
    TMPDIR: "/tmp",
  };
}

/** True when the panel should hand this server to the service account. */
export function requiresIsolation(software: string): boolean {
  return software === "python" || software === "node";
}

export function serviceDirectoryOwner(path: string): { uid: number; gid: number } | null {
  try {
    const stat = statSync(path);
    return { uid: stat.uid, gid: stat.gid };
  } catch {
    return null;
  }
}

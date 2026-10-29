import { randomUUID } from "node:crypto";
import { query, queryOne, insert, run, getSetting, setSetting, getDb } from "../database";
import { DEFAULT_ROLES } from "../shared/permissions";
import { hashPassword } from "../security/passwords";
import { hostPlatform, PORT, MODE, APP_VERSION, PATHS } from "../shared/config";
import { notify } from "./notifications";
import { recordAudit } from "./audit";
import { randomBytes } from "node:crypto";

export const BOOTSTRAP_USERNAME = "admin";
export const BOOTSTRAP_PASSWORD = "admin123";

export function needsSetup(): boolean {
  const count = queryOne<{ c: number }>("SELECT COUNT(*) AS c FROM users")?.c ?? 0;
  return count === 0;
}

/** Seeds default roles, the local node and the bootstrap administrator. Idempotent. */
export async function bootstrap(): Promise<void> {
  const connection = getDb(); // ensures migrations ran

  // Profile pictures of deleted accounts (and half-written temp files) never survive a restart.
  const { pruneOrphanAvatars } = await import("./avatars");
  pruneOrphanAvatars();

  for (const role of DEFAULT_ROLES) {
    const existing = queryOne<{ id: number }>("SELECT id FROM roles WHERE name = ?", [role.name]);
    let roleId: number;
    if (!existing) {
      roleId = insert("INSERT INTO roles (name, description, is_system) VALUES (?, ?, ?)", [
        role.name, role.description, role.isSystem ? 1 : 0,
      ]);
      for (const permission of role.permissions) {
        run("INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES (?, ?)", [roleId, permission]);
      }
    } else {
      roleId = existing.id;
    }
  }

  // Local node — the panel host itself.
  const localNode = queryOne<{ id: number }>("SELECT id FROM nodes WHERE is_local = 1");
  if (!localNode) {
    const platform = hostPlatform();
    insert(
      `INSERT INTO nodes (uuid, name, description, fqdn, scheme, port, location, is_local, public, daemon_version, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
      [
        randomUUID(), "Local Node", "The machine running this RSLMC panel.", "127.0.0.1", "http", PORT,
        "Local", APP_VERSION,
        JSON.stringify({ os: platform.os, arch: platform.arch, managedInline: true }),
      ],
    );
  }

  if (!getSetting("panel.installed_at")) {
    setSetting("panel.installed_at", new Date().toISOString());
    setSetting("panel.version", APP_VERSION);
    setSetting("panel.first_node_uuid", queryOne<{ uuid: string }>("SELECT uuid FROM nodes WHERE is_local = 1")!.uuid);
  }

  if (needsSetup()) {
    const adminRole = queryOne<{ id: number }>("SELECT id FROM roles WHERE name = 'Administrator'")!;
    const passwordHash = await hashPassword(BOOTSTRAP_PASSWORD);
    const userId = insert(
      `INSERT INTO users (username, password_hash, is_root, must_change_password, avatar_color)
       VALUES (?, ?, 1, 1, ?)`,
      [BOOTSTRAP_USERNAME, passwordHash, "#1f6f4a"],
    );
    run("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)", [userId, adminRole.id]);
    const agentSecret = randomBytes(32).toString("hex");
    setSetting("security.agent_secret", agentSecret, true);
    insert(
      `INSERT INTO notifications (user_id, severity, kind, title, body, link)
       VALUES (?, 'warning', 'password_rotation', ?, ?, '/account/security')`,
      [
        userId,
        "Important: Change your default administrator password immediately to protect your account.",
        "RSLMC was initialised with a bootstrap password. Until you change it, sensitive administrative operations are restricted.",
      ],
    );
    recordAudit({
      actorId: userId,
      actorName: BOOTSTRAP_USERNAME,
      action: "panel.bootstrap",
      type: "panel.bootstrap",
      targetType: "user",
      targetId: userId,
      result: "success",
      metadata: { mode: MODE, dataDir: PATHS.data, version: APP_VERSION },
    });
    console.log("[rslmc] Bootstrap administrator created. Change the password after first login.");
  }

  // Clean expired sessions on boot.
  run("DELETE FROM sessions WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now')");

  /*
   * Backfill JVM flags for servers created before presets existed. Only rows with *empty* flags are
   * touched, so a custom command line is never rewritten behind the user's back.
   */
  try {
    const { defaultJvmArgsFor } = await import("../minecraft/jvm-presets");
    const rows = query<{ id: number; software: any; memory_mb: number; jvm_args: string | null }>(
      "SELECT id, software, memory_mb, jvm_args FROM servers WHERE jvm_args IS NULL OR trim(jvm_args) = ''",
    );
    for (const row of rows) {
      const flags = defaultJvmArgsFor(row.software, row.memory_mb);
      if (flags) run("UPDATE servers SET jvm_args = ? WHERE id = ?", [flags, row.id]);
    }
    if (rows.length > 0) console.log(`[rslmc] applied default JVM flags to ${rows.length} server(s) without any`);
  } catch (error) {
    console.warn("[rslmc] could not backfill JVM flags:", error);
  }

  // Recover servers that were running before an unclean shutdown.
  run(
    `UPDATE servers SET status = 'offline'
     WHERE status IN ('starting','online','stopping','restarting','installing')`,
  );

  connection.exec("PRAGMA optimize;");
}

export function localNodeId(): number {
  const row = queryOne<{ id: number }>("SELECT id FROM nodes WHERE is_local = 1");
  if (!row) throw new Error("Local node is missing — database bootstrap failed");
  return row.id;
}

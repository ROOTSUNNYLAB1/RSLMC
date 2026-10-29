import { insert, query, queryOne, run } from "../database";
import { userTopic, bus } from "../events/bus";
import type { NotificationRecord } from "../shared/types";

export interface NotifyInput {
  userId?: number | null;
  severity?: "info" | "success" | "warning" | "error";
  kind?: string;
  title: string;
  body?: string | null;
  link?: string | null;
  dedupeKey?: string | null;
}

const mapRow = (row: any): NotificationRecord => ({
  id: row.id,
  userId: row.user_id,
  severity: row.severity,
  title: row.title,
  body: row.body,
  link: row.link,
  kind: row.kind,
  readAt: row.read_at,
  createdAt: row.created_at,
});

export function notify(input: NotifyInput): NotificationRecord | null {
  const dedupeKey = input.dedupeKey ?? null;
  if (dedupeKey) {
    const existing = queryOne<{ id: number }>("SELECT id FROM notifications WHERE dedupe_key = ? AND read_at IS NULL", [dedupeKey]);
    if (existing) return null;
  }
  let id: number;
  try {
    id = insert(
      `INSERT INTO notifications (user_id, severity, kind, title, body, link, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [input.userId ?? null, input.severity ?? "info", input.kind ?? "system", input.title, input.body ?? null, input.link ?? null, dedupeKey],
    );
  } catch {
    return null; // dedupe unique index conflict
  }
  const row = queryOne("SELECT * FROM notifications WHERE id = ?", [id]);
  if (!row) return null;
  const record = mapRow(row);
  if (record.userId) bus.publish(userTopic(record.userId), { type: "notification", notification: record });
  else {
    const admins = query<{ id: number }>("SELECT id FROM users WHERE is_root = 1 OR disabled = 0");
    for (const admin of admins) bus.publish(userTopic(admin.id), { type: "notification", notification: record });
  }
  return record;
}

export function listNotifications(userId: number, limit = 50, offset = 0) {
  const rows = query(
    "SELECT * FROM notifications WHERE user_id IS NULL OR user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?",
    [userId, limit, offset],
  );
  const unread = queryOne<{ c: number }>(
    "SELECT COUNT(*) AS c FROM notifications WHERE (user_id IS NULL OR user_id = ?) AND read_at IS NULL",
    [userId],
  )?.c ?? 0;
  return { items: rows.map(mapRow), unread };
}

export function markRead(userId: number, id: number): void {
  run(
    "UPDATE notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND (user_id IS NULL OR user_id = ?)",
    [id, userId],
  );
}

export function markAllRead(userId: number): void {
  run(
    "UPDATE notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE (user_id IS NULL OR user_id = ?) AND read_at IS NULL",
    [userId],
  );
}

export function dismiss(userId: number, id: number): void {
  run("DELETE FROM notifications WHERE id = ? AND (user_id IS NULL OR user_id = ?)", [id, userId]);
}

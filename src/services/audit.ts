import { insert, query, queryOne } from "../database";
import type { ActivityRecord, AuditRecord } from "../shared/types";
import { redact } from "../security/redact";

export interface EventInput {
  type?: string;
  serverId?: number | null;
  actorId?: number | null;
  actorName?: string | null;
  target?: string | null;
  result?: "success" | "failure" | "info";
  metadata?: Record<string, unknown> | null;
}

/** Server-scoped activity feed (shown on the Activity page). */
export function recordActivity(input: EventInput): void {
  insert(
    "INSERT INTO activity_events (server_id, actor_id, actor_name, type, target, result, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      input.serverId ?? null,
      input.actorId ?? null,
      input.actorName ?? null,
      input.type ?? "event",
      input.target ?? null,
      input.result ?? "success",
      input.metadata ? JSON.stringify(redact(input.metadata)) : null,
    ],
  );
}

/** Panel-wide audit trail for security-sensitive actions. */
export function recordAudit(
  input: EventInput & { ip?: string | null; action?: string; targetType?: string | null; targetId?: string | number | null },
): void {
  insert(
    "INSERT INTO audit_events (actor_id, actor_name, ip, action, target_type, target_id, result, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      input.actorId ?? null,
      input.actorName ?? null,
      input.ip ?? null,
      input.action ?? input.type ?? "event",
      input.targetType ?? null,
      input.targetId != null ? String(input.targetId) : null,
      input.result ?? "success",
      input.metadata ? JSON.stringify(redact(input.metadata)) : null,
    ],
  );
}

const mapActivity = (row: any): ActivityRecord => ({
  id: row.id,
  ts: row.ts,
  serverId: row.server_id,
  serverName: row.server_name ?? null,
  actorName: row.actor_name,
  type: row.type,
  target: row.target,
  result: row.result,
  metadata: row.metadata ? safeJson(row.metadata) : null,
});

export function listActivity(opts: {
  serverId?: number;
  types?: string[];
  search?: string;
  limit: number;
  offset: number;
}): { items: ActivityRecord[]; total: number } {
  const where: string[] = [];
  const params: any[] = [];
  if (opts.serverId) { where.push("a.server_id = ?"); params.push(opts.serverId); }
  if (opts.types?.length) { where.push(`a.type IN (${opts.types.map(() => "?").join(",")})`); params.push(...opts.types); }
  if (opts.search) {
    where.push("(a.actor_name LIKE ? OR a.target LIKE ? OR a.type LIKE ?)");
    const like = `%${opts.search}%`;
    params.push(like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = queryOne<{ c: number }>(
    `SELECT COUNT(*) AS c FROM activity_events a ${clause}`,
    params,
  )?.c ?? 0;
  const rows = query(
    `SELECT a.*, s.name AS server_name FROM activity_events a
     LEFT JOIN servers s ON s.id = a.server_id
     ${clause} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
    [...params, opts.limit, opts.offset],
  );
  return { items: rows.map(mapActivity), total };
}

export function listAudit(opts: { search?: string; action?: string; limit: number; offset: number }) {
  const where: string[] = [];
  const params: any[] = [];
  if (opts.action) { where.push("action = ?"); params.push(opts.action); }
  if (opts.search) {
    where.push("(actor_name LIKE ? OR action LIKE ? OR target_id LIKE ?)");
    const like = `%${opts.search}%`;
    params.push(like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = queryOne<{ c: number }>(`SELECT COUNT(*) AS c FROM audit_events ${clause}`, params)?.c ?? 0;
  const rows = query(`SELECT * FROM audit_events ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, opts.limit, opts.offset]);
  const items: AuditRecord[] = rows.map((row) => ({
    id: row.id,
    ts: row.ts,
    serverId: null,
    actorId: row.actor_id,
    actorName: row.actor_name,
    ip: row.ip,
    action: row.action,
    target: row.target_id,
    targetType: row.target_type,
    targetId: row.target_id,
    type: row.action,
    result: row.result,
    metadata: row.metadata ? safeJson(row.metadata) : null,
  }));
  return { items, total };
}

function safeJson(value: string): Record<string, unknown> | null {
  try { return JSON.parse(value); } catch { return null; }
}

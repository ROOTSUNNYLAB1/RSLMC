import { query, queryOne, run, insert } from "../database";
import { parseCron, nextCronRun } from "./cron";
import { startServer, stopServer, restartServer, sendCommand, isRunning } from "../processes/manager";
import { createBackup } from "./backups";
import { recordActivity } from "./audit";
import { notify } from "./notifications";
import { ApiException } from "../shared/http";
import type { ScheduleRecord } from "../shared/types";

const ACTIONS = ["restart", "start", "stop", "command", "backup", "announce", "cleanup"] as const;

function mapSchedule(row: any): ScheduleRecord {
  return {
    id: row.id,
    serverId: row.server_id,
    name: row.name,
    cron: row.cron,
    timezone: row.timezone,
    action: row.action,
    payload: row.payload ? JSON.parse(row.payload) : {},
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    lastResult: row.last_result,
  };
}

export function listSchedules(serverId: number): ScheduleRecord[] {
  return query("SELECT * FROM schedules WHERE server_id = ? ORDER BY id", [serverId]).map(mapSchedule);
}

export function createSchedule(serverId: number, input: {
  name: string; cron: string; action: string; payload?: Record<string, unknown>; enabled?: boolean; timezone?: string;
}): ScheduleRecord {
  if (!ACTIONS.includes(input.action as any)) throw new ApiException(400, "invalid_action", `Action must be one of: ${ACTIONS.join(", ")}`);
  let next: Date | null;
  try {
    next = nextCronRun(parseCron(input.cron));
  } catch (err) {
    throw new ApiException(400, "invalid_cron", err instanceof Error ? err.message : "Invalid cron expression");
  }
  if (!next) throw new ApiException(400, "invalid_cron", "This expression never runs");
  const id = insert(
    "INSERT INTO schedules (server_id, name, cron, timezone, action, payload, enabled, next_run_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      serverId, input.name.slice(0, 120), input.cron, input.timezone ?? "UTC", input.action,
      JSON.stringify(input.payload ?? {}), input.enabled === false ? 0 : 1, next.toISOString(),
    ],
  );
  return mapSchedule(queryOne("SELECT * FROM schedules WHERE id = ?", [id]));
}

export function updateSchedule(serverId: number, scheduleId: number, patch: Partial<ScheduleRecord>): ScheduleRecord {
  const row = queryOne<any>("SELECT * FROM schedules WHERE id = ? AND server_id = ?", [scheduleId, serverId]);
  if (!row) throw new ApiException(404, "schedule_not_found", "Schedule not found");
  const cron = (patch.cron as string) ?? row.cron;
  let next: Date | null = null;
  try { next = nextCronRun(parseCron(cron)); } catch (err) {
    throw new ApiException(400, "invalid_cron", err instanceof Error ? err.message : "Invalid cron expression");
  }
  run(
    "UPDATE schedules SET name = ?, cron = ?, action = ?, payload = ?, enabled = ?, timezone = ?, next_run_at = ? WHERE id = ?",
    [
      patch.name ?? row.name, cron, patch.action ?? row.action,
      patch.payload ? JSON.stringify(patch.payload) : row.payload,
      (patch.enabled ?? row.enabled === 1) ? 1 : 0,
      patch.timezone ?? row.timezone, next?.toISOString() ?? null, scheduleId,
    ],
  );
  return mapSchedule(queryOne("SELECT * FROM schedules WHERE id = ?", [scheduleId]));
}

export function deleteSchedule(serverId: number, scheduleId: number): void {
  run("DELETE FROM schedules WHERE id = ? AND server_id = ?", [scheduleId, serverId]);
}

/**
 * Run history for one schedule. Scoped by server id: without it, any account that could reach
 * `/api/servers/<own>/schedules/<other id>/runs` read another server's execution log.
 */
export function runHistory(serverId: number, scheduleId: number, limit = 50) {
  const owned = queryOne<{ id: number }>("SELECT id FROM schedules WHERE id = ? AND server_id = ?", [scheduleId, serverId]);
  if (!owned) throw new ApiException(404, "schedule_not_found", "Schedule not found");
  return query("SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY id DESC LIMIT ?", [scheduleId, limit]);
}

export async function executeSchedule(
  scheduleId: number,
  trigger: "timer" | "manual" = "timer",
  /**
   * When a person triggers the run, the schedule must belong to a server they can reach. The timer
   * passes nothing and keeps working exactly as before. Without this, `/servers/A/schedules/12/run`
   * executed schedule 12 of server B — a cross-server command/stop injection.
   */
  options: { serverId?: number } = {},
): Promise<{ ok: boolean; output: string }> {
  const row = options.serverId === undefined
    ? queryOne<any>("SELECT * FROM schedules WHERE id = ?", [scheduleId])
    : queryOne<any>("SELECT * FROM schedules WHERE id = ? AND server_id = ?", [scheduleId, options.serverId]);
  if (!row) return { ok: false, output: "Schedule not found" };
  const payload = row.payload ? JSON.parse(row.payload) : {};
  const runId = insert("INSERT INTO schedule_runs (schedule_id, started_at, status) VALUES (?, ?, 'running')", [
    scheduleId, new Date().toISOString(),
  ]);
  let ok = true;
  let output = "";
  try {
    switch (row.action) {
      case "start":
        await startServer(row.server_id, `schedule:${row.name}`);
        output = "Server start requested";
        break;
      case "stop":
        if (isRunning(row.server_id)) await stopServer(row.server_id, `schedule:${row.name}`);
        output = "Server stop requested";
        break;
      case "restart":
        await restartServer(row.server_id, `schedule:${row.name}`);
        output = "Server restart completed";
        break;
      case "command":
        if (!isRunning(row.server_id)) throw new Error("Server is not running");
        sendCommand(row.server_id, String(payload.command ?? "list"), `schedule:${row.name}`);
        output = `Command sent: ${payload.command}`;
        break;
      case "announce":
        if (!isRunning(row.server_id)) throw new Error("Server is not running");
        sendCommand(row.server_id, `say ${String(payload.message ?? "Scheduled announcement")}`, `schedule:${row.name}`);
        output = "Announcement broadcast";
        break;
      case "backup": {
        const backup = await createBackup(row.server_id, {
          name: `scheduled-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`,
          kind: (payload.kind as any) ?? "full",
          description: `Created by schedule "${row.name}"`,
          actor: `schedule:${row.name}`,
        });
        output = `Backup created: ${backup.fileName} (${backup.sizeBytes} bytes)`;
        break;
      }
      case "cleanup": {
        const days = Number(payload.olderThanDays ?? 7);
        const { rmSync, readdirSync, statSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { serverDir } = await import("../shared/config");
        const server = queryOne<{ uuid: string }>("SELECT uuid FROM servers WHERE id = ?", [row.server_id]);
        if (server) {
          const logsDir = join(serverDir(server.uuid), "logs");
          let removed = 0;
          try {
            for (const file of readdirSync(logsDir)) {
              const stat = statSync(join(logsDir, file));
              if (Date.now() - stat.mtimeMs > days * 86400_000) { rmSync(join(logsDir, file), { force: true }); removed += 1; }
            }
          } catch { /* logs directory may not exist */ }
          output = `Removed ${removed} log file(s) older than ${days} days`;
        }
        break;
      }
      default:
        throw new Error(`Unsupported action: ${row.action}`);
    }
  } catch (err) {
    ok = false;
    output = err instanceof Error ? err.message : String(err);
    notify({
      title: `Scheduled task failed: ${row.name}`,
      body: output.slice(0, 300),
      severity: "error", kind: "schedule_failed", link: `/servers/${row.server_id}/schedules`,
    });
  }

  const next = (() => {
    try { return nextCronRun(parseCron(row.cron))?.toISOString() ?? null; } catch { return null; }
  })();
  run("UPDATE schedule_runs SET finished_at = ?, status = ?, output = ? WHERE id = ?", [
    new Date().toISOString(), ok ? "success" : "failure", output.slice(0, 2000), runId,
  ]);
  run("UPDATE schedules SET last_run_at = ?, last_result = ?, next_run_at = ? WHERE id = ?", [
    new Date().toISOString(), ok ? "success" : "failure", next, scheduleId,
  ]);
  recordActivity({
    type: "schedule.executed", serverId: row.server_id, target: row.name, result: ok ? "success" : "failure",
    actorName: trigger === "manual" ? "manual" : "scheduler", metadata: { action: row.action, output: output.slice(0, 300) },
  });
  return { ok, output };
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Persistent scheduler: due schedules are read from the database, not memory. */
export function startScheduler(): void {
  if (timer) return;
  const tick = async () => {
    const due = query<any>(
      "SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?",
      [new Date().toISOString()],
    );
    for (const schedule of due) {
      await executeSchedule(schedule.id, "timer").catch((err) => {
        console.error("[rslmc] schedule execution failed", err);
      });
    }
    // Missed-job recovery: any enabled schedule with a past next_run_at is recalculated even
    // if the panel was offline when it was due.
    const stale = query<any>(
      "SELECT * FROM schedules WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at = '')",
    );
    for (const schedule of stale) {
      try {
        const next = nextCronRun(parseCron(schedule.cron));
        run("UPDATE schedules SET next_run_at = ? WHERE id = ?", [next?.toISOString() ?? null, schedule.id]);
      } catch { /* invalid expression is surfaced in the UI */ }
    }
  };
  timer = setInterval(() => void tick(), 20_000);
  void tick();
}

export function stopScheduler(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

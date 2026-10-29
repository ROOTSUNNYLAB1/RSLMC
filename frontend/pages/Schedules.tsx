import { useEffect, useState } from "react";
import { CalendarClock, Play, Plus, Trash2, History, Power } from "lucide-react";
import type { ServerSummary } from "../../src/shared/types";
import { Banner, Button, Card, ConfirmDialog, EmptyState, Field, Input, Loading, Modal, PageHeader, Pill, Select, Toggle } from "../components/ui";
import { api } from "../lib/api";
import { useSession, useToast } from "../lib/app";
import { formatDateTime, relativeTime } from "../lib/format";

interface ScheduleEntry {
  id: number; name: string; cron: string; timezone: string; action: string;
  payload: Record<string, unknown>; enabled: boolean; lastRunAt: string | null;
  nextRunAt: string | null; lastResult: string | null;
}

const PRESETS: { label: string; cron: string }[] = [
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Daily at 04:00", cron: "0 4 * * *" },
  { label: "Twice daily (04:00, 16:00)", cron: "0 4,16 * * *" },
  { label: "Weekly (Sunday 03:00)", cron: "0 3 * * 0" },
  { label: "Every 30 minutes", cron: "*/30 * * * *" },
  { label: "Custom", cron: "" },
];

export function SchedulesPage({ server }: { server: ServerSummary }) {
  const { can } = useSession();
  const toast = useToast();
  const [schedules, setSchedules] = useState<ScheduleEntry[] | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("Daily restart");
  const [cron, setCron] = useState("0 4 * * *");
  const [action, setAction] = useState("restart");
  const [payload, setPayload] = useState("");
  const [cronHint, setCronHint] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ScheduleEntry | null>(null);
  const [runs, setRuns] = useState<{ schedule: ScheduleEntry; data: any[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const result = await api.get<{ data: ScheduleEntry[] }>(`/api/servers/${server.id}/schedules`);
      setSchedules(result.data);
    } catch (err) {
      toast.fromError(err, "Could not load schedules");
      setSchedules([]);
    }
  };

  useEffect(() => { void load(); }, [server.id]);

  useEffect(() => {
    if (!cron) return;
    const timer = setTimeout(() => {
      api.post<{ ok: boolean; message: string }>("/api/cron/validate", { expression: cron })
        .then((result) => setCronHint(result.message))
        .catch(() => setCronHint(null));
    }, 300);
    return () => clearTimeout(timer);
  }, [cron]);

  const create = async () => {
    setBusy(true);
    try {
      let parsedPayload: Record<string, unknown> = {};
      if (action === "command") parsedPayload = { command: payload || "say Scheduled" };
      if (action === "announce") parsedPayload = { message: payload || "Scheduled announcement" };
      if (action === "cleanup") parsedPayload = { olderThanDays: Number(payload) || 7 };
      if (action === "backup") parsedPayload = { kind: "full" };
      await api.post(`/api/servers/${server.id}/schedules`, { name, cron, action, payload: parsedPayload });
      toast.success("Schedule created", cronHint ?? undefined);
      setOpen(false);
      await load();
    } catch (err) {
      toast.fromError(err, "Could not create schedule");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Schedules"
        icon={<CalendarClock size={19} />}
        subtitle={<>Automation for <strong style={{ color: "var(--text)" }}>{server.name}</strong> · persisted in SQLite, survives restarts</>}
        actions={<Button variant="primary" icon={<Plus size={14} />} onClick={() => setOpen(true)} disabled={!can("server.schedules")}>New schedule</Button>}
      />

      <Card bodyClass="tight">
        {schedules === null ? <Loading label="Loading schedules…" /> : schedules.length === 0 ? (
          <EmptyState
            icon={<CalendarClock size={17} />}
            title="No schedules"
            description="Automate daily restarts, timed backups, announcements and log cleanup. Jobs run from the panel's persistent scheduler and record their history."
            action={<Button variant="primary" onClick={() => setOpen(true)}>Create a schedule</Button>}
          />
        ) : (
          <table className="table">
            <thead><tr><th>Name</th><th>Action</th><th>Cron</th><th>Next run</th><th>Last run</th><th>Enabled</th><th className="actions">Actions</th></tr></thead>
            <tbody>
              {schedules.map((schedule) => (
                <tr key={schedule.id}>
                  <td><strong>{schedule.name}</strong><div className="text-xs faint">{schedule.timezone}</div></td>
                  <td><Pill tone="neutral">{schedule.action}</Pill></td>
                  <td className="mono text-xs">{schedule.cron}</td>
                  <td className="text-xs">{schedule.nextRunAt ? relativeTime(schedule.nextRunAt) : "—"}</td>
                  <td className="text-xs">
                    {schedule.lastRunAt ? relativeTime(schedule.lastRunAt) : "never"}
                    {schedule.lastResult ? <div><Pill tone={schedule.lastResult === "success" ? "green" : "red"}>{schedule.lastResult}</Pill></div> : null}
                  </td>
                  <td>
                    <Toggle
                      checked={schedule.enabled}
                      disabled={!can("server.schedules")}
                      onChange={async (value) => {
                        try {
                          await api.patch(`/api/servers/${server.id}/schedules/${schedule.id}`, { enabled: value });
                          await load();
                        } catch (err) { toast.fromError(err, "Could not update schedule"); }
                      }}
                    />
                  </td>
                  <td className="actions">
                    <Button
                      size="sm" icon={<Play size={12} />}
                      onClick={async () => {
                        try {
                          const result = await api.post<{ ok: boolean; output: string }>(`/api/servers/${server.id}/schedules/${schedule.id}/run`);
                          if (result.ok) toast.success("Schedule executed", result.output);
                          else toast.error("Schedule failed", result.output);
                          await load();
                        } catch (err) { toast.fromError(err, "Could not run schedule"); }
                      }}
                    >
                      Run now
                    </Button>
                    <Button
                      size="sm" variant="ghost" icon={<History size={12} />}
                      onClick={async () => {
                        const result = await api.get<{ data: any[] }>(`/api/servers/${server.id}/schedules/${schedule.id}/runs`);
                        setRuns({ schedule, data: result.data });
                      }}
                    >
                      History
                    </Button>
                    <Button size="sm" variant="danger" icon={<Trash2 size={12} />} onClick={() => setDeleteTarget(schedule)} disabled={!can("server.schedules")}>Delete</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Banner tone="info" title="Missed jobs">
        If the panel was offline when a job was due, the schedule's next run is recalculated from the cron expression on the next boot rather than firing a backlog of missed executions.
      </Banner>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New schedule"
        footer={<>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void create()} disabled={!cron}>Create schedule</Button>
        </>}
      >
        <Field label="Name"><Input value={name} onChange={(event) => setName(event.target.value)} /></Field>
        <Field label="Action">
          <Select value={action} onChange={(event) => setAction(event.target.value)}>
            <option value="restart">Restart server</option>
            <option value="start">Start server</option>
            <option value="stop">Stop server</option>
            <option value="command">Run console command</option>
            <option value="announce">Broadcast announcement</option>
            <option value="backup">Create backup</option>
            <option value="cleanup">Clean old log files</option>
          </Select>
        </Field>
        {["command", "announce", "cleanup"].includes(action) ? (
          <Field label={action === "command" ? "Command" : action === "announce" ? "Message" : "Older than (days)"} hint={action === "cleanup" ? "Log files older than this are deleted." : undefined}>
            <Input value={payload} onChange={(event) => setPayload(event.target.value)} placeholder={action === "command" ? "say Hello" : action === "announce" ? "Server restarting soon" : "7"} />
          </Field>
        ) : null}
        <Field label="Recurrence" hint={cronHint ?? "Standard 5-field cron expression in UTC."}>
          <Select
            value={PRESETS.some((preset) => preset.cron === cron) ? cron : "custom"}
            onChange={(event) => { if (event.target.value !== "custom") setCron(event.target.value); }}
          >
            {PRESETS.map((preset) => <option key={preset.label} value={preset.cron || "custom"}>{preset.label}</option>)}
          </Select>
        </Field>
        <Field label="Cron expression">
          <Input value={cron} onChange={(event) => setCron(event.target.value)} className="input mono" placeholder="0 4 * * *" />
        </Field>
      </Modal>

      <Modal open={runs !== null} onClose={() => setRuns(null)} title={`Run history · ${runs?.schedule.name ?? ""}`} size="wide">
        {runs?.data.length === 0 ? <EmptyState icon={<History size={16} />} title="No runs yet" description="Executions are recorded with their output." /> : (
          <table className="table">
            <thead><tr><th>Started</th><th>Finished</th><th>Status</th><th>Output</th></tr></thead>
            <tbody>
              {runs?.data.map((run) => (
                <tr key={run.id}>
                  <td className="text-xs">{formatDateTime(run.started_at)}</td>
                  <td className="text-xs">{run.finished_at ? formatDateTime(run.finished_at) : "—"}</td>
                  <td><Pill tone={run.status === "success" ? "green" : run.status === "running" ? "amber" : "red"}>{run.status}</Pill></td>
                  <td className="text-xs mono truncate" style={{ maxWidth: 320 }}>{run.output ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={`Delete schedule ${deleteTarget?.name}?`}
        confirmLabel="Delete"
        message="The schedule and its run history are removed."
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            await api.delete(`/api/servers/${server.id}/schedules/${deleteTarget.id}`);
            toast.success("Schedule deleted");
            setDeleteTarget(null);
            await load();
          } catch (err) { toast.fromError(err, "Could not delete schedule"); }
        }}
      />
    </>
  );
}

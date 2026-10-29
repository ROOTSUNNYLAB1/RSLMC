import { useEffect, useState } from "react";
import { Activity, Search, ScrollText, Filter } from "lucide-react";
import type { ServerSummary } from "../../src/shared/types";
import { Button, Card, EmptyState, Loading, PageHeader, Pill, Select } from "../components/ui";
import { api } from "../lib/api";
import { formatDateTime } from "../lib/format";

interface ActivityRecord {
  id: number; ts: string; actorName: string | null; type: string; target: string | null;
  result: string; metadata: Record<string, unknown> | null;
}

const TYPES = [
  "server.started", "server.stopped", "server.crashed", "server.killed", "server.start", "server.stop",
  "server.restart", "player.joined", "player.left", "player.op", "player.deop", "player.ban", "player.pardon",
  "player.kick", "player.whitelist_add", "player.whitelist_remove", "file.uploaded", "file.edited",
  "plugin.installed", "plugin.removed", "backup.created", "backup.restored", "properties.changed",
  "console.command", "schedule.executed", "world.created", "world.deleted",
];

export function ActivityPage({ server }: { server?: ServerSummary; global?: boolean }) {
  const [items, setItems] = useState<ActivityRecord[] | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const base = server ? `/api/servers/${server.id}/activity` : "/api/activity";
      const params = new URLSearchParams({ page: String(page), perPage: "30" });
      if (search) params.set("search", search);
      if (type) params.set("types", type);
      const result = await api.get<{ items: ActivityRecord[]; total: number; totalPages: number }>(`${base}?${params.toString()}`);
      setItems(result.items);
      setTotal(result.total);
      setTotalPages(result.totalPages);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load activity");
    }
  };

  useEffect(() => { void load(); }, [server?.id, page, type]);

  useEffect(() => {
    const timer = setTimeout(() => { if (page === 1) void load(); else setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  return (
    <>
      <PageHeader
        title="Activity"
        icon={<Activity size={19} />}
        subtitle={server ? <>Event log for <strong style={{ color: "var(--text)" }}>{server.name}</strong></> : "All server and panel events"}
        actions={
          <div className="row" style={{ gap: 6 }}>
            <div className="row" style={{ gap: 6 }}>
              <Search size={12} className="faint" />
              <input className="input" style={{ height: 28, width: 190 }} placeholder="Search events…" value={search} onChange={(event) => setSearch(event.target.value)} />
            </div>
            <Select style={{ height: 28, width: 190 }} value={type} onChange={(event) => { setType(event.target.value); setPage(1); }}>
              <option value="">All event types</option>
              {TYPES.map((entry) => <option key={entry} value={entry}>{entry.replace(/[._]/g, " ")}</option>)}
            </Select>
            <Button icon={<Filter size={13} />} onClick={() => void load()}>Refresh</Button>
          </div>
        }
      />

      {error ? <div className="banner error">{error}</div> : null}

      <Card title={`${total} events`} icon={<ScrollText size={12} />} bodyClass="tight">
        {items === null ? <Loading label="Loading activity…" /> : items.length === 0 ? (
          <EmptyState icon={<Activity size={17} />} title="No activity yet" description="Lifecycle, player, file and security events are recorded here as they happen." />
        ) : (
          <>
            <table className="table">
              <thead><tr><th>Time</th><th>Event</th><th>Actor</th><th>Target</th><th>Result</th><th>Details</th></tr></thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td className="text-xs nowrap">{formatDateTime(item.ts)}</td>
                    <td><span className="mono text-xs">{item.type}</span></td>
                    <td className="text-xs">{item.actorName ?? "system"}</td>
                    <td className="text-xs truncate" style={{ maxWidth: 200 }}>{item.target ?? "—"}</td>
                    <td><Pill tone={item.result === "failure" ? "red" : item.result === "info" ? "blue" : "green"}>{item.result}</Pill></td>
                    <td className="text-xs faint mono truncate" style={{ maxWidth: 260 }}>
                      {item.metadata ? JSON.stringify(item.metadata).slice(0, 90) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row" style={{ padding: "10px 14px", borderTop: "1px solid var(--border)" }}>
              <span className="text-xs faint">Page {page} of {totalPages}</span>
              <span className="spacer" />
              <Button size="sm" onClick={() => setPage(Math.max(1, page - 1))} disabled={page === 1}>Previous</Button>
              <Button size="sm" onClick={() => setPage(Math.min(totalPages, page + 1))} disabled={page >= totalPages}>Next</Button>
            </div>
          </>
        )}
      </Card>
    </>
  );
}

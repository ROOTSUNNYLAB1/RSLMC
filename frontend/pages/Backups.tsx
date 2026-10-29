import { useEffect, useState } from "react";
import { Archive, CheckCircle2, Clock, Download, RefreshCw, RotateCcw, ShieldCheck, Trash2, XCircle } from "lucide-react";
import type { ServerSummary } from "../../src/shared/types";
import { Banner, Button, Card, ConfirmDialog, EmptyState, Field, Input, Loading, Modal, PageHeader, Pill, ProgressBar, Select, StatCard } from "../components/ui";
import { api } from "../lib/api";
import { useSession, useToast } from "../lib/app";
import { usePanelSocket } from "../lib/ws";
import { formatBytes, formatDateTime, relativeTime } from "../lib/format";

interface BackupEntry {
  id: number; uuid: string; name: string; description: string | null; kind: string;
  fileName: string; sizeBytes: number; status: string; sha256: string | null;
  createdAt: string; completedAt: string | null; createdBy: string | null; error: string | null;
}

export function BackupsPage({ server }: { server: ServerSummary }) {
  const { can } = useSession();
  const toast = useToast();
  const [backups, setBackups] = useState<BackupEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"full" | "worlds" | "config" | "plugins">("full");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ label: string; progress: number; total: number; done: boolean; error?: string } | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<BackupEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BackupEntry | null>(null);

  const load = async () => {
    try {
      const result = await api.get<{ data: BackupEntry[] }>(`/api/servers/${server.id}/backups`);
      setBackups(result.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load backups");
    }
  };

  useEffect(() => { void load(); }, [server.id]);

  usePanelSocket(server.id, (message) => {
    if (message.type === "progress" && message.kind === "backup") {
      setProgress({ label: message.label, progress: message.progress, total: message.total, done: message.done, error: message.error });
      if (message.done) void load();
    }
  });

  const create = async () => {
    setBusy(true);
    try {
      await api.post(`/api/servers/${server.id}/backups`, { name: name.trim() || undefined, kind });
      toast.success("Backup started", "Progress is streamed below.");
      setCreateOpen(false);
      setName("");
      await load();
    } catch (err) {
      toast.fromError(err, "Backup failed");
    } finally {
      setBusy(false);
    }
  };

  const completed = (backups ?? []).filter((backup) => backup.status === "completed");
  const totalSize = completed.reduce((sum, backup) => sum + backup.sizeBytes, 0);

  return (
    <>
      <PageHeader
        title="Backups"
        icon={<Archive size={19} />}
        subtitle={<>Archives for <strong style={{ color: "var(--text)" }}>{server.name}</strong> · integrity-verified tar.gz</>}
        actions={
          <>
            <Button icon={<RefreshCw size={14} />} onClick={() => void load()}>Refresh</Button>
            <Button variant="primary" icon={<Archive size={14} />} onClick={() => setCreateOpen(true)} disabled={!can("server.backups")}>Create backup</Button>
          </>
        }
      />

      {error ? <Banner tone="error" title="Could not load backups">{error}</Banner> : null}

      {progress ? (
        <Banner tone={progress.error ? "error" : progress.done ? "success" : "info"} title={progress.label}>
          {progress.error ?? (progress.total > 0 ? `${formatBytes(progress.progress)} of ${formatBytes(progress.total)}` : "Working…")}
          <div style={{ marginTop: 8 }}>
            <ProgressBar value={progress.total > 0 ? (progress.progress / progress.total) * 100 : progress.done ? 100 : 30} tone={progress.error ? "var(--red)" : "var(--green)"} />
          </div>
        </Banner>
      ) : null}

      <div className="stat-grid" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        <StatCard label="Backups" icon={<Archive size={11} />} accent="var(--green)" value={backups?.length ?? 0} meta={<span>{completed.length} completed</span>} />
        <StatCard label="Storage used" icon={<ShieldCheck size={11} />} accent="var(--amber)" value={formatBytes(totalSize)} meta={<span>in runtime/backups</span>} />
        <StatCard label="Retention" icon={<Clock size={11} />} accent="var(--blue)" value="10" meta={<span>oldest archives pruned automatically</span>} />
      </div>

      <Card bodyClass="tight">
        {backups === null ? <Loading label="Loading backups…" /> : backups.length === 0 ? (
          <EmptyState
            icon={<Archive size={17} />}
            title="No backups yet"
            description="Create a backup before upgrading software, deleting worlds or installing new plugins. Archives are compressed, checksummed and verified."
            action={<Button variant="primary" onClick={() => setCreateOpen(true)}>Create the first backup</Button>}
          />
        ) : (
          <table className="table">
            <thead>
              <tr><th>Name</th><th>Type</th><th>Size</th><th>Status</th><th>Created</th><th>By</th><th className="actions">Actions</th></tr>
            </thead>
            <tbody>
              {backups.map((backup) => (
                <tr key={backup.id}>
                  <td>
                    <strong>{backup.name}</strong>
                    <div className="text-xs faint mono truncate" style={{ maxWidth: 260 }}>{backup.fileName}</div>
                  </td>
                  <td><Pill tone="neutral">{backup.kind}</Pill></td>
                  <td>{formatBytes(backup.sizeBytes)}</td>
                  <td>
                    {backup.status === "completed" ? <Pill tone="green" dot>completed</Pill>
                      : backup.status === "failed" ? <Pill tone="red" dot>failed</Pill>
                      : backup.status === "running" ? <Pill tone="amber" dot>running</Pill>
                      : <Pill tone="neutral">{backup.status}</Pill>}
                  </td>
                  <td className="text-xs">{formatDateTime(backup.createdAt)}<div className="faint">{relativeTime(backup.createdAt)}</div></td>
                  <td className="text-xs">{backup.createdBy ?? "system"}</td>
                  <td className="actions">
                    <Button size="sm" icon={<Download size={12} />} onClick={() => window.open(`/api/servers/${server.id}/backups/${backup.id}/download`, "_blank")} disabled={backup.status !== "completed"}>Download</Button>
                    <Button size="sm" icon={<RotateCcw size={12} />} onClick={() => setRestoreTarget(backup)} disabled={backup.status !== "completed" || !can("server.backups")}>Restore</Button>
                    <Button size="sm" variant="danger" icon={<Trash2 size={12} />} onClick={() => setDeleteTarget(backup)} disabled={!can("server.backups")}>Delete</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create backup"
        footer={<>
          <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void create()}>Start backup</Button>
        </>}
      >
        <Field label="Backup name" hint="Defaults to a timestamped name.">
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="before-upgrade" />
        </Field>
        <Field label="Contents" hint="A world backup flushes and disables auto-save first so the archive is consistent.">
          <Select value={kind} onChange={(event) => setKind(event.target.value as any)}>
            <option value="full">Full server (worlds, config, plugins)</option>
            <option value="worlds">Worlds only</option>
            <option value="config">Configuration only</option>
            <option value="plugins">Plugins / mods only</option>
          </Select>
        </Field>
      </Modal>

      <ConfirmDialog
        open={restoreTarget !== null}
        title={`Restore ${restoreTarget?.name}?`}
        tone="primary"
        confirmLabel="Restore backup"
        message={<>
          The current server directory is moved aside (not deleted) and the archive is extracted in its place.
          The server must be stopped. You can roll back by restoring the <span className="mono">.pre-restore-*</span> folder.
        </>}
        onClose={() => setRestoreTarget(null)}
        onConfirm={async () => {
          if (!restoreTarget) return;
          try {
            await api.post(`/api/servers/${server.id}/backups/${restoreTarget.id}/restore`);
            toast.success("Restore complete", "Start the server to verify the restored data.");
            setRestoreTarget(null);
            await load();
          } catch (err) { toast.fromError(err, "Restore failed"); }
        }}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title={`Delete ${deleteTarget?.name}?`}
        confirmLabel="Delete backup"
        message="The archive file is removed from disk. This cannot be undone."
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            await api.delete(`/api/servers/${server.id}/backups/${deleteTarget.id}`);
            toast.success("Backup deleted");
            setDeleteTarget(null);
            await load();
          } catch (err) { toast.fromError(err, "Could not delete backup"); }
        }}
      />
    </>
  );
}

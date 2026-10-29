import { useEffect, useState } from "react";
import { Earth, Plus, Trash2, Download, ShieldAlert, RefreshCw, Boxes, Database } from "lucide-react";
import type { ServerSummary } from "../../src/shared/types";
import { Banner, Button, Card, ConfirmDialog, EmptyState, Field, Input, Loading, Modal, PageHeader, Pill, StatCard } from "../components/ui";
import { api } from "../lib/api";
import { useSession, useToast } from "../lib/app";
import { formatBytes, relativeTime } from "../lib/format";

interface WorldEntry {
  id: number; name: string; folder: string; environment: string; sizeBytes: number;
  seed: string | null; protected: boolean; lastUpdated: string | null;
  dimensions?: { nether: boolean; end: boolean };
}

export function WorldsPage({ server }: { server: ServerSummary }) {
  const { can } = useSession();
  const toast = useToast();
  const [worlds, setWorlds] = useState<WorldEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [folder, setFolder] = useState("");
  const [seed, setSeed] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<WorldEntry | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const result = await api.get<{ data: WorldEntry[] }>(`/api/servers/${server.id}/worlds`);
      setWorlds(result.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read worlds");
    }
  };

  useEffect(() => { void load(); }, [server.id]);

  const totalSize = (worlds ?? []).reduce((sum, world) => sum + world.sizeBytes, 0);

  return (
    <>
      <PageHeader
        title="Worlds"
        icon={<Earth size={19} />}
        subtitle={<>World folders for <strong style={{ color: "var(--text)" }}>{server.name}</strong> · detected from disk, not from a stored list</>}
        actions={
          <>
            <Button icon={<RefreshCw size={14} />} onClick={() => void load()}>Rescan</Button>
            <Button variant="primary" icon={<Plus size={14} />} onClick={() => setCreateOpen(true)} disabled={!can("server.worlds")}>New world</Button>
          </>
        }
      />

      {error ? <Banner tone="error" title="Could not read worlds">{error}</Banner> : null}

      <div className="stat-grid" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        <StatCard label="Worlds" icon={<Earth size={11} />} accent="var(--green)" value={worlds?.length ?? 0} meta={<span>detected on disk</span>} />
        <StatCard label="Total size" icon={<Database size={11} />} accent="var(--amber)" value={formatBytes(totalSize)} meta={<span>level.dat + regions</span>} />
        <StatCard label="Dimensions" icon={<Boxes size={11} />} accent="var(--blue)" value={worlds?.reduce((sum, world) => sum + 1 + (world.dimensions?.nether ? 1 : 0) + (world.dimensions?.end ? 1 : 0), 0) ?? 0} meta={<span>Overworld, Nether, End</span>} />
      </div>

      {worlds === null ? <Loading label="Scanning world folders…" /> : worlds.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Earth size={17} />}
            title="No worlds detected"
            description="Start the server once so Minecraft generates the default world, or create an empty world folder and point level-name at it."
          />
        </Card>
      ) : (
        <div className="grid grid-2">
          {worlds.map((world) => (
            <Card
              key={world.id}
              title={world.folder}
              icon={<Earth size={12} />}
              actions={world.protected ? <Pill tone="blue">primary</Pill> : <Pill tone="neutral">secondary</Pill>}
            >
              <div className="info-list" style={{ margin: "-14px", marginBottom: 10 }}>
                <div className="info-row"><span className="k">Size</span><span className="v">{formatBytes(world.sizeBytes)}</span></div>
                <div className="info-row"><span className="k">Seed</span><span className="v mono text-xs">{world.seed ?? "unknown (not stored in level.dat)"}</span></div>
                <div className="info-row"><span className="k">Last played</span><span className="v">{world.lastUpdated ? relativeTime(world.lastUpdated) : "—"}</span></div>
                <div className="info-row">
                  <span className="k">Dimensions</span>
                  <span className="v row" style={{ gap: 4, justifyContent: "flex-end" }}>
                    <Pill tone="green">overworld</Pill>
                    {world.dimensions?.nether ? <Pill tone="red">nether</Pill> : null}
                    {world.dimensions?.end ? <Pill tone="violet">end</Pill> : null}
                  </span>
                </div>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <Button size="sm" icon={<Download size={12} />} onClick={() => window.open(`/api/servers/${server.id}/files/archive?path=${encodeURIComponent(world.folder)}`, "_blank")}>
                  Export
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    try {
                      await api.post(`/api/servers/${server.id}/backups`, { name: `world-${world.folder}`, kind: "worlds", description: `Manual world backup of ${world.folder}` });
                      toast.success("World backup started", "Progress is shown on the Backups page.");
                    } catch (err) { toast.fromError(err, "Backup failed"); }
                  }}
                  disabled={!can("server.backups")}
                >
                  Backup world
                </Button>
                <span className="spacer" />
                <Button
                  size="sm" variant="danger" icon={<Trash2 size={12} />}
                  disabled={world.protected || !can("server.worlds")}
                  title={world.protected ? "The primary world is protected" : "Delete this world"}
                  onClick={() => setDeleteTarget(world)}
                >
                  Delete
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Banner tone="info" title="About Nether and End dimensions">
        In vanilla Minecraft the Nether (<span className="mono">DIM-1</span>) and End (<span className="mono">DIM1</span>) live inside the main world folder. They cannot be deleted independently, so RSLMC reports them as dimensions instead of separate worlds.
      </Banner>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create a world"
        footer={<>
          <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post(`/api/servers/${server.id}/worlds`, { folder: folder.trim(), seed: seed.trim() || undefined });
                toast.success("World folder created", "Set level-name in server.properties to activate it.");
                setCreateOpen(false);
                setFolder(""); setSeed("");
                await load();
              } catch (err) { toast.fromError(err, "Could not create world"); }
              finally { setBusy(false); }
            }}
          >
            Create world
          </Button>
        </>}
      >
        <Field label="World folder name" hint="Letters, numbers, - and _ only. Minecraft generates the level data on first load.">
          <Input value={folder} onChange={(event) => setFolder(event.target.value)} placeholder="survival_2026" />
        </Field>
        <Field label="Seed (optional)" hint="Stored as a note in the folder; the generator uses level-seed in server.properties.">
          <Input value={seed} onChange={(event) => setSeed(event.target.value)} placeholder="123456789" />
        </Field>
        <Banner tone="warning" title="Activation is manual by design">
          RSLMC creates the folder and metadata but does not silently repoint <span className="mono">level-name</span>, because that would switch your running world.
        </Banner>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={`Delete world ${deleteTarget?.folder}?`}
        confirmLabel="Delete world"
        requireText={deleteTarget?.folder}
        message={<>
          This permanently deletes the world folder. An automatic backup is created first, and can be restored from the Backups page.
        </>}
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            await api.delete(`/api/servers/${server.id}/worlds/${deleteTarget.id}`, { confirmName: deleteTarget.folder, backupFirst: true });
            toast.success("World deleted", "A safety backup was created first.");
            setDeleteTarget(null);
            await load();
          } catch (err) { toast.fromError(err, "Could not delete world"); }
        }}
      />
    </>
  );
}

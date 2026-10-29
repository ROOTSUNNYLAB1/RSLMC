import { useEffect, useState } from "react";
import {
  Activity, Cpu, Download, Gauge, Globe2, HardDrive, KeyRound, Plus, RefreshCw, ScrollText,
  Server, ShieldCheck, Trash2, Users2, MemoryStick, Terminal, CheckCircle2, AlertTriangle, Info,
  UserPlus, UserCheck, Save, CircleAlert,
} from "lucide-react";
import {
  Avatar, Banner, Button, Card, ConfirmDialog, EmptyState, Field, Input, Loading, Modal, PageHeader,
  Pill, ProgressBar, Select, StatCard, Tabs, Toggle, InfoList, CopyValue,
} from "../components/ui";
import { api } from "../lib/api";
import { roleHasAdminAccess } from "../../src/shared/permissions";
import { useSession, useToast } from "../lib/app";
import { Link, useRouter } from "../lib/router";
import { formatBytes, formatDateTime, formatDuration, relativeTime, statusLabel, statusTone } from "../lib/format";

/* ------------------------------- Sub-navigation -------------------------- */
export function AdminNav({ active }: { active: string }) {
  const { can } = useSession();
  const items = [
    { key: "", label: "Overview", permission: ["node.view", "user.view"] },
    { key: "nodes", label: "Nodes", permission: "node.view" },
    { key: "servers", label: "Servers", permission: "server.view" },
    { key: "users", label: "Users", permission: "user.view" },
    { key: "roles", label: "Roles", permission: "user.view" },
    { key: "signin", label: "Sign-in", permission: ["system.manage", "user.manage"] },
    { key: "java", label: "Java Runtimes", permission: "java.manage" },
    { key: "audit", label: "Audit Log", permission: "audit.view" },
    { key: "system", label: "System", permission: "system.manage" },
    { key: "about", label: "About", permission: ["system.manage", "node.view"] },
  ].filter((item) => can(item.permission));
  return (
    <div className="tabs-bar" style={{ marginBottom: 14 }}>
      <div className="tabs" role="tablist" aria-label="Administration sections">
        {items.map((item) => (
          <Link
            key={item.key || "overview"}
            to={item.key ? `/admin/${item.key}` : "/admin"}
            role="tab"
            aria-selected={active === item.key}
            className={`tab ${active === item.key ? "active" : ""}`}
          >
            {item.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------- Dashboard ------------------------------ */
export function AdminDashboardPage() {
  const [data, setData] = useState<any>(null);
  const { navigate } = useRouter();

  useEffect(() => { api.get<any>("/api/admin/overview").then(setData).catch(() => setData(null)); }, []);

  if (!data) return <Loading label="Loading administration data…" minHeight={280} />;

  return (
    <>
      <PageHeader
        title="Admin Panel"
        icon={<ShieldCheck size={19} />}
        subtitle="Panel-wide health, capacity and recent activity."
        actions={<Button icon={<Gauge size={14} />} onClick={() => navigate("/admin/system")}>System</Button>}
      />
      <div className="stat-grid">
        <StatCard label="Servers" icon={<Server size={11} />} accent="var(--green)" value={data.counts.servers} meta={<span>{data.counts.onlineServers} online · {data.counts.offlineServers} offline</span>} />
        <StatCard label="Users" icon={<Users2 size={11} />} accent="var(--blue)" value={data.counts.users} meta={<span>{data.counts.onlineNodes}/{data.counts.nodes} nodes online</span>} />
        <StatCard label="Players online" icon={<Activity size={11} />} accent="var(--green)" value={data.counts.playersOnline} meta={<span>all nodes</span>} />
        <StatCard label="Allocated memory" icon={<MemoryStick size={11} />} accent="var(--amber)" value={(data.resources.allocatedMemoryMb / 1024).toFixed(1)} unit="GB" meta={<span>of {formatBytes(data.resources.host.memoryTotalBytes)} host RAM</span>} progress={(data.resources.allocatedMemoryMb * 1024 * 1024 / Math.max(1, data.resources.host.memoryTotalBytes)) * 100} />
        <StatCard label="Host CPU" icon={<Cpu size={11} />} accent="var(--blue)" value={data.resources.host.cpuUsagePercent.toFixed(1)} unit="%" meta={<span>{data.resources.host.cpuCores} cores · {data.resources.allocatedCpuPercent}% allocated</span>} progress={data.resources.host.cpuUsagePercent} />
        <StatCard label="Storage" icon={<HardDrive size={11} />} accent="var(--amber)" value={formatBytes(data.resources.disk.usedBytes)} meta={<span>{formatBytes(data.resources.disk.freeBytes)} free</span>} progress={(data.resources.disk.usedBytes / Math.max(1, data.resources.disk.totalBytes)) * 100} />
      </div>

      <div className="grid grid-2">
        <Card title="Nodes" icon={<Globe2 size={12} />} bodyClass="tight">
          <table className="table">
            <thead><tr><th>Node</th><th>Address</th><th>Status</th><th>Last heartbeat</th></tr></thead>
            <tbody>
              {data.nodes.map((node: any) => (
                <tr key={node.id}>
                  <td><strong>{node.name}</strong>{node.isLocal ? <Pill tone="blue">local</Pill> : null}</td>
                  <td className="mono text-xs">{node.fqdn}</td>
                  <td>{node.online ? <Pill tone="green" dot>online</Pill> : <Pill tone="red" dot>offline</Pill>}</td>
                  <td className="text-xs">{node.lastHeartbeatAt ? relativeTime(node.lastHeartbeatAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="Security" icon={<ShieldCheck size={12} />} bodyClass="tight">
          <InfoList
            rows={[
              { key: "Development mode", value: data.security.weakMode ? <Pill tone="amber">yes — secure cookies off</Pill> : <Pill tone="green">no</Pill> },
              { key: "Users needing password change", value: data.security.mustChangePasswordUsers },
              { key: "Users with 2FA", value: data.security.totpEnabled },
              { key: "Failed operations (24h)", value: data.counts.failedOps },
              { key: "Memory enforcement", value: <Pill tone={data.enforcement.memory.level === "enforced" ? "green" : "amber"}>{data.enforcement.memory.level}</Pill> },
              { key: "CPU enforcement", value: <Pill tone={data.enforcement.cpu.level === "enforced" ? "green" : "amber"}>{data.enforcement.cpu.level}</Pill> },
            ]}
          />
        </Card>
      </div>

      <Card title="Recent events" icon={<Activity size={12} />} bodyClass="tight" header>
        <table className="table">
          <thead><tr><th>Time</th><th>Event</th><th>Server</th><th>Actor</th><th>Result</th></tr></thead>
          <tbody>
            {data.recentEvents.map((event: any) => (
              <tr key={event.id}>
                <td className="text-xs">{formatDateTime(event.ts)}</td>
                <td className="mono text-xs">{event.type}</td>
                <td className="text-xs">{event.serverName ?? "—"}</td>
                <td className="text-xs">{event.actorName ?? "system"}</td>
                <td><Pill tone={event.result === "failure" ? "red" : "green"}>{event.result}</Pill></td>
              </tr>
            ))}
            {data.recentEvents.length === 0 ? <tr><td colSpan={5} className="faint text-xs">No events recorded yet.</td></tr> : null}
          </tbody>
        </table>
      </Card>
    </>
  );
}

/* --------------------------------- Nodes -------------------------------- */
export function NodesPage() {
  const toast = useToast();
  const { can } = useSession();
  const [nodes, setNodes] = useState<any[] | null>(null);
  const [self, setSelf] = useState<any | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", fqdn: "", scheme: "https", port: 8443, location: "" });
  const [enrolled, setEnrolled] = useState<{ agentKey: string; reachable: boolean; probeError: string | null; node: any } | null>(null);
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [keyNode, setKeyNode] = useState<any | null>(null);
  const [keyValue, setKeyValue] = useState("");
  const [selfKey, setSelfKey] = useState("");
  const [selfUrl, setSelfUrl] = useState("");
  const [deleteNode, setDeleteNode] = useState<any | null>(null);

  const load = () =>
    Promise.all([
      api.get<{ data: any[] }>("/api/nodes").then((result) => setNodes(result.data)).catch(() => setNodes([])),
      api.get<{ self: any }>("/api/nodes/self").then((result) => setSelf(result.self)).catch(() => setSelf(null)),
    ]);

  useEffect(() => {
    void load();
    // Live figures: the controller re-probes every 15 s, so the page follows along without a reload.
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, []);

  const testConnection = async (node: any) => {
    setTestingId(node.id);
    try {
      const result = await api.post<{ ok: boolean; message: string; latencyMs?: number }>(`/api/nodes/${node.id}/test`);
      if (result.ok) toast.success("Node is online", result.message);
      else toast.error("Node did not answer", result.message);
      await load();
    } catch (error) {
      toast.fromError(error, "Connection test failed");
      await load();
    } finally {
      setTestingId(null);
    }
  };

  const remoteNodes = (nodes ?? []).filter((node) => !node.isLocal);
  const localNode = (nodes ?? []).find((node) => node.isLocal);

  return (
    <>
      <PageHeader
        title="Nodes"
        icon={<Globe2 size={19} />}
        subtitle="Machines that run Minecraft servers. The local node is this panel; additional nodes are other RSLMC installations it controls."
        actions={
          <div className="row" style={{ gap: 8 }}>
            <Button icon={<RefreshCw size={14} />} onClick={() => void load()}>Refresh</Button>
            <Button variant="primary" icon={<Plus size={14} />} onClick={() => setOpen(true)} disabled={!can("node.manage")}>New node</Button>
          </div>
        }
      />

      {!nodes ? <Loading label="Loading nodes…" /> : (
        <div className="stack">
          {nodes.map((node) => (
            <Card
              key={node.id}
              title={<>{node.name} {node.isLocal ? <Pill tone="blue">local</Pill> : null} {node.maintenance ? <Pill tone="amber">maintenance</Pill> : null}</>}
              icon={<Globe2 size={12} />}
              actions={
                <div className="row" style={{ gap: 6 }}>
                  <Pill tone={node.online ? "green" : node.lastStatus === "offline" ? "red" : "neutral"} dot>
                    {node.online ? "online" : node.lastStatus === "offline" ? "offline" : "not checked yet"}
                  </Pill>
                  {!node.isLocal && can("node.manage") ? (
                    <>
                      <Button size="sm" icon={<RefreshCw size={12} />} loading={testingId === node.id} onClick={() => void testConnection(node)}>Test</Button>
                      <Button size="sm" icon={<KeyRound size={12} />} onClick={() => { setKeyNode(node); setKeyValue(""); }}>Key</Button>
                      <Button size="sm" variant="danger" icon={<Trash2 size={12} />} onClick={() => setDeleteNode(node)}>Delete</Button>
                    </>
                  ) : null}
                </div>
              }
            >
              <div className="grid grid-3" style={{ gap: 14 }}>
                <div className="info-list" style={{ margin: -14 }}>
                  <div className="info-row"><span className="k">Address</span><span className="v mono text-xs">{node.scheme}://{node.fqdn}:{node.port}</span></div>
                  <div className="info-row"><span className="k">Location</span><span className="v">{node.location ?? "—"}</span></div>
                  <div className="info-row"><span className="k">Servers</span><span className="v">{node.serverCount}{node.linkedServers ? ` (${node.linkedServers} this panel)` : ""}</span></div>
                  <div className="info-row"><span className="k">Version</span><span className="v">{node.daemonVersion ? `RSLMC ${node.daemonVersion}` : node.isLocal ? "this panel" : "unknown"}</span></div>
                  <div className="info-row">
                    <span className="k">Last heartbeat</span>
                    <span className="v">
                      {node.isLocal ? "not applicable — this panel" : node.lastHeartbeatAt ? relativeTime(node.lastHeartbeatAt) : "never"}
                    </span>
                  </div>
                </div>

                {node.stats ? (
                  <>
                    <div>
                      <div className="card-title" style={{ marginBottom: 6 }}><Cpu size={11} /> CPU</div>
                      <div className="text-sm">{Number(node.stats.cpuUsagePercent ?? 0).toFixed(1)}% of {node.stats.cpuCores} cores</div>
                      <ProgressBar value={Number(node.stats.cpuUsagePercent ?? 0)} />
                      <div className="card-title" style={{ margin: "10px 0 6px" }}><MemoryStick size={11} /> Memory</div>
                      <div className="text-sm">{formatBytes(node.stats.memoryUsedBytes ?? 0)} / {formatBytes(node.stats.memoryTotalBytes ?? 0)}</div>
                      <ProgressBar value={node.stats.memoryTotalBytes ? (node.stats.memoryUsedBytes / node.stats.memoryTotalBytes) * 100 : 0} tone="var(--green)" />
                    </div>
                    <div>
                      <div className="card-title" style={{ marginBottom: 6 }}><HardDrive size={11} /> Disk</div>
                      <div className="text-sm">{formatBytes(node.stats.diskUsedBytes ?? 0)} / {formatBytes(node.stats.diskTotalBytes ?? 0)}</div>
                      <ProgressBar value={node.stats.diskTotalBytes ? (node.stats.diskUsedBytes / node.stats.diskTotalBytes) * 100 : 0} tone="var(--amber)" />
                      <div className="text-xs faint" style={{ marginTop: 10 }}>
                        {node.stats.os ?? "—"} · {node.stats.arch ?? "—"} · Bun {node.stats.bunVersion ?? "—"}
                        {node.stats.latencyMs !== undefined ? ` · answered in ${node.stats.latencyMs} ms` : ""}
                      </div>
                      <div className="row" style={{ marginTop: 6, gap: 6 }}>
                        <Pill tone={node.stats.agents?.cgroups ? "green" : "amber"}>
                          {node.stats.agents?.cgroups ? "cgroups enforced" : "limits advisory"}
                        </Pill>
                        {node.stats.servers ? <Pill tone="neutral">{node.stats.servers.running}/{node.stats.servers.total} servers running</Pill> : null}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="empty" style={{ gridColumn: "span 2" }}>
                    <p>
                      {node.isLocal
                        ? "This panel is the local node."
                        : node.lastError
                          ? node.lastError
                          : "This node has not been enrolled yet. Register it here, then paste the agent key into that panel's own Nodes page."}
                    </p>
                  </div>
                )}
              </div>
            </Card>
          ))}

          {remoteNodes.length > 0 ? (
            <Card title="What lives where" icon={<Server size={12} />}>
              <p className="text-sm faint" style={{ margin: 0, lineHeight: 1.6 }}>
                Server records, users and roles are handled by this panel. The files, the Java process, backups and console
                of a server on a remote node are handled by that node — this panel forwards your request there after checking
                that you are allowed to make it. If a node is offline, its servers show as unreachable instead of pretending
                to be running.
              </p>
            </Card>
          ) : null}

          {/* -------------------------- This panel as a node -------------------------- */}
          <Card
            title="This panel as a node"
            icon={<KeyRound size={12} />}
            actions={<Pill tone={self?.enabled ? "green" : "neutral"} dot>{self?.enabled ? "enrolled" : "stand-alone"}</Pill>}
          >
            {!self ? <Loading label="Reading node state…" /> : self.enabled ? (
              <div className="stack">
                <InfoList rows={[
                  { key: "Role", value: "Node of a controller panel" },
                  { key: "Controller", value: self.controllerLabel ?? "a controller panel" },
                  { key: "Key fingerprint", value: <span className="mono text-xs">{self.fingerprint}</span> },
                  { key: "Requests accepted", value: String(self.requestsAccepted) },
                  { key: "This panel", value: `RSLMC ${self.panelVersion} · ${self.mode} · port ${self.port}` },
                ]} />
                {can("node.manage") ? (
                  <Button
                    variant="danger"
                    icon={<Trash2 size={13} />}
                    onClick={async () => {
                      try {
                        await api.delete("/api/nodes/self/key");
                        toast.success("Disconnected", "This panel no longer accepts requests from that controller.");
                        await load();
                      } catch (error) { toast.fromError(error, "Could not disconnect"); }
                    }}
                  >
                    Disconnect from controller
                  </Button>
                ) : null}
              </div>
            ) : (
              <div className="stack">
                <p className="text-sm faint" style={{ margin: 0, lineHeight: 1.6 }}>
                  To let another RSLMC panel manage servers on this machine, register this address on that panel and paste
                  the agent key it shows you here. Nothing changes until a key is saved: until then this panel ignores every
                  controller request.
                </p>
                <div className="form-grid">
                  <Field label="Agent key" required hint="Shown once, on the controller's Nodes page.">
                    <Input value={selfKey} onChange={(event) => setSelfKey(event.target.value)} placeholder="paste the key from the controller" />
                  </Field>
                  <Field label="Controller URL" hint="Optional — used to verify the link immediately.">
                    <Input value={selfUrl} onChange={(event) => setSelfUrl(event.target.value)} placeholder="https://panel.example.com" />
                  </Field>
                </div>
                <div className="row">
                  <Button
                    variant="primary"
                    loading={busy}
                    disabled={!can("node.manage") || selfKey.trim().length < 24}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        const result = await api.post<{ verified: boolean | null; verifyError: string | null }>("/api/nodes/self/key", {
                          key: selfKey.trim(), controllerUrl: selfUrl.trim() || undefined,
                        });
                        if (result.verified) toast.success("Connected", "The controller confirmed the key.");
                        else if (result.verified === false) toast.error("Key saved, but not confirmed", result.verifyError ?? "The controller did not accept the key.");
                        else toast.success("Key saved", "This panel now accepts requests from that controller.");
                        setSelfKey("");
                        await load();
                      } catch (error) { toast.fromError(error, "Could not save the key"); }
                      finally { setBusy(false); }
                    }}
                  >
                    Save key
                  </Button>
                </div>
              </div>
            )}
          </Card>

          {localNode ? (
            <Banner tone="info" title="How a second machine is added">
              1. On the other machine, install RSLMC and open its Nodes page. 2. Here, press <strong>New node</strong> and enter
              that machine's address — the panel shows an agent key once. 3. Paste that key into the other panel's
              <strong> This panel as a node</strong> card. 4. Press <strong>Test connection</strong>: the node reports its real
              CPU, memory and disk from then on.
            </Banner>
          ) : null}
        </div>
      )}

      {/* --------------------------------- Register -------------------------------- */}
      <Modal
        open={open}
        onClose={() => { setOpen(false); setEnrolled(null); }}
        title="Register a node"
        footer={<>
          <Button onClick={() => { setOpen(false); setEnrolled(null); }}>Close</Button>
          {!enrolled ? (
            <Button
              variant="primary" loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const result = await api.post<{ agentKey: string; reachable: boolean; probeError: string | null; node: any; message: string }>("/api/nodes", {
                    name: form.name, description: form.description || undefined, fqdn: form.fqdn,
                    scheme: form.scheme, port: Number(form.port), location: form.location || undefined,
                  });
                  setEnrolled({ agentKey: result.agentKey, reachable: result.reachable, probeError: result.probeError, node: result.node });
                  await load();
                } catch (err) { toast.fromError(err, "Could not register node"); }
                finally { setBusy(false); }
              }}
            >
              Register node
            </Button>
          ) : null}
        </>}
      >
        {enrolled ? (
          <div className="stack">
            <Banner tone={enrolled.reachable ? "success" : "warning"} title={enrolled.reachable ? "Node registered and answering" : "Node registered — not answering yet"}>
              {enrolled.reachable
                ? "The address is reachable and the node reported its version. Paste the key below into that panel to finish enrolling it."
                : `${enrolled.probeError ?? "No answer from that address."} That is expected before the key is installed on the node; after you paste the key, press Test connection.`}
            </Banner>
            <Field label="Agent key — shown once" required>
              <div className="code-block">{enrolled.agentKey}</div>
            </Field>
            <div className="text-xs faint">
              Paste it on the node itself: that panel → Administration → Nodes → <strong>This panel as a node</strong> → Save key.
              The key is stored hashed on the node; this panel keeps its own copy so it can sign its requests.
            </div>
          </div>
        ) : (
          <div className="form-grid">
            <Field label="Name" required><Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="eu-frankfurt-1" /></Field>
            <Field label="Location"><Input value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} placeholder="Frankfurt, DE" /></Field>
            <Field label="Host / IP" required hint="The address this panel can reach the node on."><Input value={form.fqdn} onChange={(event) => setForm({ ...form, fqdn: event.target.value })} placeholder="node1.example.com" /></Field>
            <Field label="Port" hint="The node panel's own port."><Input type="number" value={form.port} onChange={(event) => setForm({ ...form, port: Number(event.target.value) })} /></Field>
            <Field label="Scheme"><Select value={form.scheme} onChange={(event) => setForm({ ...form, scheme: event.target.value })}><option value="https">https</option><option value="http">http</option></Select></Field>
            <Field label="Description"><Input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></Field>
          </div>
        )}
      </Modal>

      {/* ---------------------------------- Key ----------------------------------- */}
      <Modal
        open={Boolean(keyNode)}
        onClose={() => setKeyNode(null)}
        title={`Agent key — ${keyNode?.name ?? ""}`}
        footer={<>
          <Button onClick={() => setKeyNode(null)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={keyValue.trim().length < 24}
            onClick={async () => {
              try {
                const result = await api.post<{ ok: boolean; message: string }>(`/api/nodes/${keyNode.id}/key`, { key: keyValue.trim() });
                if (result.ok) toast.success("Key accepted", result.message);
                else toast.error("Key saved, node still unreachable", result.message);
                setKeyNode(null);
                setKeyValue("");
                await load();
              } catch (error) { toast.fromError(error, "Could not save the key"); }
            }}
          >
            Save and test
          </Button>
        </>}
      >
        <div className="stack">
          <p className="text-sm faint" style={{ margin: 0, lineHeight: 1.6 }}>
            Paste the agent key from the node's own Nodes page. Keys are only ever shown on the node, so this is the only way to
            pair the two panels again after a reinstall or a key rotation.
          </p>
          <Field label="Agent key" required><Input value={keyValue} onChange={(event) => setKeyValue(event.target.value)} /></Field>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteNode)}
        title="Remove this node?"
        message={
          deleteNode
            ? `"${deleteNode.name}" will be forgotten by this panel. ${deleteNode.linkedServers ? `${deleteNode.linkedServers} server(s) created through this panel live on it — delete those first.` : "No servers from this panel live on it."}`
            : ""
        }
        confirmLabel="Remove node"
        tone="danger"
        onClose={() => setDeleteNode(null)}
        onConfirm={async () => {
          try {
            await api.delete(`/api/nodes/${deleteNode.id}`);
            toast.success("Node removed");
            setDeleteNode(null);
            await load();
          } catch (error) { toast.fromError(error, "Could not remove the node"); }
        }}
      />
    </>
  );
}

/* ------------------------- Server allocation ----------------------------- */

interface AllocationEntry {
  id: number;
  name: string;
  software: string;
  mcVersion: string;
  status: string;
  relation: "owner" | "shared" | "none";
  ownerName: string | null;
}

const RELATION_LABEL: Record<AllocationEntry["relation"], string> = {
  owner: "Owner",
  shared: "Shared access",
  none: "No access",
};

/**
 * Hands specific servers to an account. Ownership and shared access are separate: the owner column is
 * what the account's own server list is built from, shared access is an extra grant. Changes are only
 * sent when the administrator saves, so a half-finished edit never reaches the API.
 */
function ServerAllocationModal({ target, onClose, onSaved }: {
  target: { id: number; username: string } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [entries, setEntries] = useState<AllocationEntry[] | null>(null);
  const [draft, setDraft] = useState<Record<number, AllocationEntry["relation"]>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!target) return;
    setEntries(null);
    setDraft({});
    api.get<{ data: AllocationEntry[] }>(`/api/users/${target.id}/servers`)
      .then((result) => {
        setEntries(result.data);
        setDraft(Object.fromEntries(result.data.map((entry) => [entry.id, entry.relation])));
      })
      .catch((err) => { toast.fromError(err, "Could not load server access"); onClose(); });
  }, [target?.id]);

  const counts = Object.values(draft);
  const changed = entries?.some((entry) => draft[entry.id] !== entry.relation) ?? false;

  const save = async () => {
    if (!target || !entries) return;
    setSaving(true);
    try {
      const owner = entries.filter((entry) => draft[entry.id] === "owner").map((entry) => entry.id);
      const shared = entries.filter((entry) => draft[entry.id] === "shared").map((entry) => entry.id);
      await api.put(`/api/users/${target.id}/servers`, { owner, shared });
      toast.success("Server access updated", `${target.username}: ${owner.length} owned, ${shared.length} shared.`);
      onSaved();
      onClose();
    } catch (err) {
      toast.fromError(err, "Could not update server access");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={Boolean(target)}
      onClose={onClose}
      title={target ? `Servers for ${target.username}` : "Servers"}
      size="wide"
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={save} loading={saving} disabled={!changed}>
          Save access
        </Button>
      </>}
    >
      {!entries ? <Loading label="Loading servers…" /> : entries.length === 0 ? (
        <EmptyState
          icon={<Server size={17} />}
          title="No servers yet"
          description="Create a server first — then you can allocate it to this account."
        />
      ) : (
        <>
          <div className="alloc-summary">
            <Pill tone="blue">{counts.filter((value) => value === "owner").length} owned</Pill>
            <Pill tone="green">{counts.filter((value) => value === "shared").length} shared</Pill>
            <Pill tone="neutral">{counts.filter((value) => value === "none").length} no access</Pill>
          </div>
          <div className="alloc-list">
            {entries.map((entry) => (
              <div className="alloc-row" key={entry.id}>
                <div className="alloc-main">
                  <span className="alloc-name">{entry.name}</span>
                  <span className="alloc-meta">
                    {entry.software} · {entry.mcVersion}
                    {entry.ownerName && draft[entry.id] !== "owner" ? ` · currently ${entry.ownerName}'s` : ""}
                  </span>
                </div>
                <span className="alloc-select">
                  <Select
                    value={draft[entry.id] ?? "none"}
                    onChange={(event) => setDraft({ ...draft, [entry.id]: event.target.value as AllocationEntry["relation"] })}
                  >
                    {(Object.keys(RELATION_LABEL) as AllocationEntry["relation"][]).map((relation) => (
                      <option key={relation} value={relation}>{RELATION_LABEL[relation]}</option>
                    ))}
                  </Select>
                </span>
              </div>
            ))}
          </div>
          <p className="alloc-note">
            <ShieldCheck size={13} />
            <span>
              Owners get the full server workspace (console, files, players, plugins, worlds, backups,
              schedules). Shared access grants the same pages without moving ownership. Neither can reach
              resource limits, networking allocations or the administration area.
            </span>
          </p>
        </>
      )}
    </Modal>
  );
}

/* ---------------------------- Single sign-on ---------------------------- */

interface OauthState {
  discord: { enabled: boolean; clientId: string; secretSet: boolean };
  google: {
    enabled: boolean; clientId: string; secretSet: boolean;
    firebaseApiKeySet: boolean; firebaseProjectId: string;
  };
  allowRegistration: boolean;
  linkByEmail: boolean;
  ready: { discord: boolean; google: boolean };
  identities: number;
  lastLogins: number;
}

/**
 * Sign-in provider configuration. Deliberately compact: two provider cards, one shared policy row and
 * the exact redirect URI each provider console needs (the #1 reason an OAuth setup fails).
 * Secrets are write-only — the form shows whether one is stored, never the value.
 */
export function SignInPage() {
  const toast = useToast();
  const { can } = useSession();
  const [state, setState] = useState<OauthState | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    discordClientId: "", discordSecret: "",
    googleClientId: "", googleSecret: "", firebaseApiKey: "", firebaseProjectId: "",
  });
  const canManage = can(["system.manage", "user.manage"]);
  const redirectBase = window.location.origin;

  useEffect(() => {
    api.get<OauthState>("/api/system/oauth").then((result) => {
      setState(result);
      setDraft((current) => ({
        ...current,
        discordClientId: result.discord.clientId,
        googleClientId: result.google.clientId,
        firebaseProjectId: result.google.firebaseProjectId,
      }));
    }).catch(() => setState(null));
  }, []);

  const save = async (patch: Record<string, unknown>, message: string, key: string) => {
    setSaving(key);
    try {
      const next = await api.put<OauthState>("/api/system/oauth", patch);
      setState(next);
      toast.success(message);
      return true;
    } catch (err) {
      toast.fromError(err, "Could not save the sign-in settings");
      return false;
    } finally {
      setSaving(null);
    }
  };

  if (!state) return <Loading label="Loading sign-in providers…" minHeight={240} />;

  return (
    <>
      <PageHeader
        title="Sign-in"
        icon={<ShieldCheck size={19} />}
        subtitle="Let people sign in with Discord or Google (through Firebase). Password sign-in always keeps working."
        actions={
          <div className="row" style={{ gap: 8 }}>
            <Pill tone={state.discord.enabled ? "green" : "neutral"} dot>{state.discord.enabled ? "Discord on" : "Discord off"}</Pill>
            <Pill tone={state.google.enabled ? "green" : "neutral"} dot>{state.google.enabled ? "Google on" : "Google off"}</Pill>
          </div>
        }
      />

      <div className="sso-admin-grid">
        {/* ---------------- Discord ---------------- */}
        <Card
          title={<span className="sso-card-title"><span className="sso-badge discord">Discord</span></span>}
          icon={<KeyRound size={12} />}
          actions={
            <Toggle
              checked={state.discord.enabled}
              disabled={!canManage || saving !== null}
              label={state.discord.enabled ? "On" : "Off"}
              onChange={(next) => void save({ discord: { enabled: next } }, next ? "Discord sign-in enabled" : "Discord sign-in disabled", "discord-toggle")}
            />
          }
        >
          <div className="stack" style={{ gap: 11 }}>
            <Field label="Client ID" hint="Developer Portal → your application → OAuth2.">
              <Input
                value={draft.discordClientId}
                onChange={(event) => setDraft({ ...draft, discordClientId: event.target.value })}
                placeholder="e.g. 123456789012345678"
                spellCheck={false}
                disabled={!canManage}
              />
            </Field>
            <Field label="Client secret" hint={state.discord.secretSet ? "A secret is stored. Type a new one to replace it." : "Never leaves the server once saved."}>
              <Input
                type="password"
                value={draft.discordSecret}
                onChange={(event) => setDraft({ ...draft, discordSecret: event.target.value })}
                placeholder={state.discord.secretSet ? "•••••••• (stored)" : "paste the client secret"}
                autoComplete="new-password"
                disabled={!canManage}
              />
            </Field>
            <Field label="Redirect URI" hint="Paste this into the Developer Portal exactly as shown.">
              <CopyValue value={`${redirectBase}/api/auth/oauth/discord/callback`} />
            </Field>
            <div className="row" style={{ gap: 8 }}>
              <Button
                variant="primary"
                icon={<Save size={13} />}
                loading={saving === "discord"}
                disabled={!canManage}
                onClick={async () => {
                  const ok = await save({
                    discord: {
                      clientId: draft.discordClientId,
                      clientSecret: draft.discordSecret || undefined,
                    },
                  }, "Discord credentials saved", "discord");
                  if (ok) setDraft({ ...draft, discordSecret: "" });
                }}
              >
                Save credentials
              </Button>
              {state.discord.secretSet ? (
                <Button
                  variant="ghost"
                  disabled={!canManage}
                  onClick={() => void save({ discord: { enabled: false, clientSecret: null } }, "Discord credentials cleared", "discord")}
                >
                  Clear secret
                </Button>
              ) : null}
            </div>
            {!state.ready.discord ? (
              <div className="sso-hint"><CircleAlert size={13} /><span>Add a client ID and secret, then this switch will accept “On”.</span></div>
            ) : null}
          </div>
        </Card>

        {/* ---------------- Google via Firebase ---------------- */}
        <Card
          title={<span className="sso-card-title"><span className="sso-badge google">Google</span><Pill tone="violet">via Firebase</Pill></span>}
          icon={<KeyRound size={12} />}
          actions={
            <Toggle
              checked={state.google.enabled}
              disabled={!canManage || saving !== null}
              label={state.google.enabled ? "On" : "Off"}
              onChange={(next) => void save({ google: { enabled: next } }, next ? "Google sign-in enabled" : "Google sign-in disabled", "google-toggle")}
            />
          }
        >
          <div className="stack" style={{ gap: 11 }}>
            <Field label="OAuth client ID" hint="Google Cloud console → Credentials → OAuth client (Web application).">
              <Input
                value={draft.googleClientId}
                onChange={(event) => setDraft({ ...draft, googleClientId: event.target.value })}
                placeholder="e.g. 1234567890-abc.apps.googleusercontent.com"
                spellCheck={false}
                disabled={!canManage}
              />
            </Field>
            <Field label="OAuth client secret" hint={state.google.secretSet ? "A secret is stored. Type a new one to replace it." : "Used only during the server-side code exchange."}>
              <Input
                type="password"
                value={draft.googleSecret}
                onChange={(event) => setDraft({ ...draft, googleSecret: event.target.value })}
                placeholder={state.google.secretSet ? "•••••••• (stored)" : "paste the client secret"}
                autoComplete="new-password"
                disabled={!canManage}
              />
            </Field>
            <Field label="Firebase web API key" hint="Firebase console → Project settings → Your apps → Web API key. Verifies the Google identity.">
              <Input
                type="password"
                value={draft.firebaseApiKey}
                onChange={(event) => setDraft({ ...draft, firebaseApiKey: event.target.value })}
                placeholder={state.google.firebaseApiKeySet ? "•••••••• (stored)" : "paste the Firebase web API key"}
                autoComplete="new-password"
                disabled={!canManage}
              />
            </Field>
            <Field label="Firebase project ID" hint="Only used as a label here — handy when the same Firebase project is shared with the game servers.">
              <Input
                value={draft.firebaseProjectId}
                onChange={(event) => setDraft({ ...draft, firebaseProjectId: event.target.value })}
                placeholder="e.g. my-rslmc-project"
                spellCheck={false}
                disabled={!canManage}
              />
            </Field>
            <Field label="Redirect URI" hint="Add this to the Google OAuth client's authorised redirect URIs.">
              <CopyValue value={`${redirectBase}/api/auth/oauth/google/callback`} />
            </Field>
            <div className="row" style={{ gap: 8 }}>
              <Button
                variant="primary"
                icon={<Save size={13} />}
                loading={saving === "google"}
                disabled={!canManage}
                onClick={async () => {
                  const ok = await save({
                    google: {
                      clientId: draft.googleClientId,
                      clientSecret: draft.googleSecret || undefined,
                      firebaseApiKey: draft.firebaseApiKey || undefined,
                      firebaseProjectId: draft.firebaseProjectId,
                    },
                  }, "Google / Firebase settings saved", "google");
                  if (ok) setDraft({ ...draft, googleSecret: "", firebaseApiKey: "" });
                }}
              >
                Save credentials
              </Button>
              {state.google.secretSet || state.google.firebaseApiKeySet ? (
                <Button
                  variant="ghost"
                  disabled={!canManage}
                  onClick={() => void save({ google: { enabled: false, clientSecret: null, firebaseApiKey: null } }, "Google credentials cleared", "google")}
                >
                  Clear secrets
                </Button>
              ) : null}
            </div>
            {!state.ready.google ? (
              <div className="sso-hint"><CircleAlert size={13} /><span>Needs a client ID, client secret and the Firebase web API key before “On” sticks.</span></div>
            ) : null}
          </div>
        </Card>
      </div>

      <Card title="Sign-in policy" icon={<ShieldCheck size={12} />}>
        <div className="reg-grid">
          <div className="reg-row">
            <div className="reg-text">
              <b>Allow new accounts from Discord / Google</b>
              <span>When off, only identities already linked to a panel account can sign in.</span>
            </div>
            <Toggle
              checked={state.allowRegistration}
              disabled={!canManage || saving !== null}
              label={state.allowRegistration ? "On" : "Off"}
              onChange={(next) => void save({ allowRegistration: next }, next ? "Provider sign-up allowed" : "Provider sign-up disabled", "policy")}
            />
          </div>
          <div className="reg-row">
            <div className="reg-text">
              <b>Link to an existing account with a verified email</b>
              <span>Only when the provider marks the address verified. Off means an admin has to link accounts by hand.</span>
            </div>
            <Toggle
              checked={state.linkByEmail}
              disabled={!canManage || saving !== null}
              label={state.linkByEmail ? "On" : "Off"}
              onChange={(next) => void save({ linkByEmail: next }, next ? "Email linking enabled" : "Email linking disabled", "policy")}
            />
          </div>
          <div className="reg-foot">
            <div className="reg-foot-item">
              <span className="k">Linked identities</span>
              <span className="v">{state.identities}</span>
            </div>
            <div className="reg-foot-item">
              <span className="k">Provider sign-ins (7 days)</span>
              <span className="v">{state.lastLogins}</span>
            </div>
            <div className="reg-foot-item">
              <span className="k">Two-factor</span>
              <span className="v" style={{ fontFamily: "var(--font)", fontSize: 12 }}>still required after SSO</span>
            </div>
          </div>
        </div>
        <div className="reg-hint" style={{ marginTop: 12 }}>
          <Info size={13} />
          <span>
            New accounts from a provider get the <b>User</b> role and no servers — allocate servers under
            Users → Servers. Accounts created this way have no password until you set one, and unlinking
            their last provider is refused.
          </span>
        </div>
      </Card>
    </>
  );
}

/* ---------------------------- Registration ------------------------------ */

interface RegistrationState {
  enabled: boolean;
  requireCode: boolean;
  defaultRole: string;
  codeSet: boolean;
  open: boolean;
  closedReason: string | null;
  createdLast7Days: number;
}

/**
 * Self-registration switch. Every control saves immediately and re-renders from the server's answer,
 * so what the panel shows is always the stored configuration — never an optimistic guess.
 */
function RegistrationCard({ roles, canManage }: { roles: any[]; canManage: boolean }) {
  const toast = useToast();
  const [state, setState] = useState<RegistrationState | null>(null);
  const [saving, setSaving] = useState(false);
  const [codeDraft, setCodeDraft] = useState("");
  const signUpUrl = `${window.location.origin}/register`;

  useEffect(() => {
    api.get<RegistrationState>("/api/system/registration")
      .then(setState)
      .catch(() => setState(null));
  }, []);

  const save = async (patch: Record<string, unknown>, message: string) => {
    setSaving(true);
    try {
      const next = await api.put<RegistrationState>("/api/system/registration", patch);
      setState(next);
      toast.success(message);
    } catch (err) {
      toast.fromError(err, "Could not update registration");
    } finally {
      setSaving(false);
    }
  };

  if (!state) {
    return (
      <Card title="Account registration" icon={<UserPlus size={12} />}>
        <Loading label="Loading registration settings…" />
      </Card>
    );
  }

  return (
    <Card
      title="Account registration"
      icon={<UserPlus size={12} />}
      actions={
        state.enabled
          ? <Pill tone="green" dot>open</Pill>
          : <Pill tone="neutral">closed</Pill>
      }
    >
      <div className="reg-grid">
        <div className="reg-row">
          <div className="reg-text">
            <b>Allow self-registration</b>
            <span>
              {state.open
                ? "Anyone who can reach this panel can create an account."
                : state.closedReason ?? "The sign-up page tells visitors that registration is closed."}
            </span>
          </div>
          <Toggle
            checked={state.enabled}
            disabled={!canManage || saving}
            label={state.enabled ? "On" : "Off"}
            onChange={(next) => save({ enabled: next }, next ? "Self-registration enabled" : "Self-registration disabled")}
          />
        </div>

        <div className="reg-row">
          <div className="reg-text">
            <b>Require a sign-up code</b>
            <span>Visitors must enter the code below before an account is created.</span>
          </div>
          <Toggle
            checked={state.requireCode}
            disabled={!canManage || saving}
            label={state.requireCode ? "On" : "Off"}
            onChange={(next) => save({ requireCode: next }, next ? "Sign-up code required" : "Sign-up code no longer required")}
          />
        </div>

        <div className="reg-row reg-row-stack">
          <div className="reg-text">
            <b>Role for new accounts</b>
            <span>Permissions come from this role until you change them on the account.</span>
          </div>
          <Select
            value={state.defaultRole}
            disabled={!canManage || saving}
            onChange={(event) => save({ defaultRole: event.target.value }, "Default role updated")}
          >
            {roles.map((role) => (
              <option key={role.name} value={role.name}>
                {role.name}{roleHasAdminAccess(role.permissions ?? []) ? " — includes admin access" : " — no admin access"}
              </option>
            ))}
            {roles.some((role) => role.name === state.defaultRole) ? null : (
              <option value={state.defaultRole}>{state.defaultRole}</option>
            )}
          </Select>
          <span className="reg-inline-note">
            <ShieldCheck size={12} /> The <b>User</b> role can start, stop, restart and force-kill the
            servers you allocate to it, use the console, files, players, plugins, worlds and backups, and
            pick a JVM startup preset. It cannot create or delete servers, change resource limits or
            networking, install Java runtimes, or open the administration area.
          </span>
        </div>

        {state.requireCode ? (
          <div className="reg-row reg-row-stack">
            <div className="reg-text">
              <b>Sign-up code</b>
              <span>
                {state.codeSet
                  ? "A code is stored. It is write-only — enter a new one to replace it."
                  : "No code stored yet. Registration stays locked until you save one."}
              </span>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <Input
                value={codeDraft}
                onChange={(event) => setCodeDraft(event.target.value)}
                placeholder={state.codeSet ? "•••••••• (stored)" : "at least 6 characters"}
                disabled={!canManage || saving}
                spellCheck={false}
                autoComplete="off"
              />
              <Button
                onClick={() => { void save({ inviteCode: codeDraft }, "Sign-up code saved").then(() => setCodeDraft("")); }}
                disabled={!canManage || saving || codeDraft.trim().length < 6}
              >
                Save code
              </Button>
              {state.codeSet ? (
                <Button variant="ghost" onClick={() => save({ inviteCode: null }, "Sign-up code cleared")} disabled={!canManage || saving}>
                  Clear
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="reg-foot">
          <div className="reg-foot-item">
            <span className="k">Sign-up page</span>
            <CopyValue value={signUpUrl} />
          </div>
          <div className="reg-foot-item">
            <span className="k">Accounts (7 days)</span>
            <span className="v">{state.createdLast7Days}</span>
          </div>
        </div>
        <div className="reg-hint">
          <UserCheck size={13} />
          <span>
            New accounts start empty. Use <b>Servers</b> next to a user below to allocate servers to them —
            they only ever see what you allocate.
          </span>
        </div>
      </div>
    </Card>
  );
}

/* --------------------------------- Users -------------------------------- */
export function UsersPage() {
  const toast = useToast();
  const { can, user } = useSession();
  const [users, setUsers] = useState<any[] | null>(null);
  const [roles, setRoles] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ username: "", email: "", password: "", roles: [] as string[], isRoot: false });
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [allocTarget, setAllocTarget] = useState<{ id: number; username: string } | null>(null);

  const load = () => {
    api.get<{ data: any[] }>("/api/users").then((result) => setUsers(result.data)).catch(() => setUsers([]));
    api.get<{ data: any[] }>("/api/roles").then((result) => setRoles(result.data)).catch(() => {});
  };
  useEffect(load, []);

  return (
    <>
      <PageHeader
        title="Users"
        icon={<Users2 size={19} />}
        subtitle="Panel accounts and their role assignments."
        actions={<Button variant="primary" icon={<Plus size={14} />} onClick={() => setOpen(true)} disabled={!can("user.manage")}>New user</Button>}
      />
      <RegistrationCard roles={roles} canManage={can("user.manage")} />
      <Card bodyClass="tight">
        {!users ? <Loading label="Loading users…" /> : (
          <table className="table">
            <thead><tr><th>User</th><th>Roles</th><th>2FA</th><th>Status</th><th>Last sign-in</th><th className="actions">Actions</th></tr></thead>
            <tbody>
              {users.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <div className="user-cell">
                      <Avatar name={entry.username} color={entry.avatarColor} url={entry.avatarUrl} size={26} />
                      <div style={{ minWidth: 0 }}>
                        <strong>{entry.username}</strong>{entry.isRoot ? <Pill tone="green">root</Pill> : null}
                        <div className="text-xs faint">{entry.email ?? "no email"}</div>
                      </div>
                    </div>
                  </td>
                  <td>{entry.roles.map((role: string) => <Pill key={role} tone="neutral">{role}</Pill>)}</td>
                  <td>
                    {entry.totpEnabled ? <Pill tone="green">on</Pill> : <Pill tone="neutral">off</Pill>}
                    {(entry.identities ?? []).map((provider: string) => (
                      <Pill key={provider} tone="violet">{provider}</Pill>
                    ))}
                  </td>
                  <td>{entry.disabled ? <Pill tone="red">disabled</Pill> : entry.mustChangePassword ? <Pill tone="amber">password change required</Pill> : <Pill tone="green">active</Pill>}</td>
                  <td className="text-xs">{entry.lastLoginAt ? relativeTime(entry.lastLoginAt) : "never"}</td>
                  <td className="actions">
                    <Button
                      size="sm" variant="ghost"
                      icon={<Server size={12} />}
                      onClick={() => setAllocTarget({ id: entry.id, username: entry.username })}
                      disabled={!can("user.manage") || entry.isRoot}
                      title={entry.isRoot ? "Root administrators already reach every server" : "Allocate servers"}
                    >
                      Servers
                    </Button>
                    <Button
                      size="sm" variant="ghost"
                      onClick={async () => {
                        const password = window.prompt(`New password for ${entry.username}`);
                        if (!password) return;
                        try {
                          await api.post(`/api/users/${entry.id}/password`, { password });
                          toast.success("Password reset", "All sessions for that user were revoked.");
                        } catch (err) { toast.fromError(err, "Could not reset password"); }
                      }}
                      disabled={!can("user.manage")}
                    >
                      Reset password
                    </Button>
                    <Button
                      size="sm" variant="ghost"
                      onClick={async () => {
                        try {
                          await api.patch(`/api/users/${entry.id}`, { disabled: !entry.disabled });
                          await load();
                          toast.success(entry.disabled ? "User enabled" : "User disabled");
                        } catch (err) { toast.fromError(err, "Could not update user"); }
                      }}
                      disabled={!can("user.manage") || entry.id === user?.id}
                    >
                      {entry.disabled ? "Enable" : "Disable"}
                    </Button>
                    <Button size="sm" variant="danger" icon={<Trash2 size={12} />} onClick={() => setDeleteTarget(entry)} disabled={!can("user.manage") || entry.id === user?.id}>Delete</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <ServerAllocationModal target={allocTarget} onClose={() => setAllocTarget(null)} onSaved={() => void load()} />

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Create user"
        footer={<>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            variant="primary"
            onClick={async () => {
              try {
                await api.post("/api/users", { ...form, email: form.email || undefined });
                toast.success("User created");
                setOpen(false);
                setForm({ username: "", email: "", password: "", roles: [], isRoot: false });
                await load();
              } catch (err) { toast.fromError(err, "Could not create user"); }
            }}
          >
            Create user
          </Button>
        </>}
      >
        <div className="form-grid">
          <Field label="Username" required><Input value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} /></Field>
          <Field label="Email"><Input value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></Field>
          <Field label="Password" className="span-2" required hint="At least 10 characters with mixed case, a number and a symbol.">
            <Input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
          </Field>
          <Field label="Roles" className="span-2">
            <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
              {roles.map((role) => (
                <button
                  key={role.id}
                  className={`tab ${form.roles.includes(role.name) ? "active" : ""}`}
                  onClick={() => setForm({
                    ...form,
                    roles: form.roles.includes(role.name) ? form.roles.filter((entry) => entry !== role.name) : [...form.roles, role.name],
                  })}
                >
                  {role.name}
                </button>
              ))}
            </div>
          </Field>
          <div className="span-2"><Toggle checked={form.isRoot} onChange={(value) => setForm({ ...form, isRoot: value })} label="Root administrator (bypasses permission checks)" /></div>
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={`Delete ${deleteTarget?.username}?`}
        confirmLabel="Delete user"
        message="The account and its sessions are removed. Users who own servers cannot be deleted until ownership is transferred."
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            await api.delete(`/api/users/${deleteTarget.id}`);
            toast.success("User deleted");
            setDeleteTarget(null);
            await load();
          } catch (err) { toast.fromError(err, "Could not delete user"); }
        }}
      />
    </>
  );
}

/* --------------------------------- Roles -------------------------------- */
export function RolesPage() {
  const toast = useToast();
  const { can } = useSession();
  const [roles, setRoles] = useState<any[] | null>(null);
  const [catalogue, setCatalogue] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<any>(null);
  const [draft, setDraft] = useState<string[]>([]);

  const load = () => api.get<{ data: any[]; catalogue: Record<string, string> }>("/api/roles").then((result) => {
    setRoles(result.data);
    setCatalogue(result.catalogue);
  }).catch(() => setRoles([]));

  useEffect(() => { void load(); }, []);

  return (
    <>
      <PageHeader title="Roles" icon={<KeyRound size={19} />} subtitle="Permission sets enforced on the backend for every request." />
      {!roles ? <Loading label="Loading roles…" /> : (
        <div className="grid grid-2">
          <Card title="Roles" icon={<ShieldCheck size={12} />} bodyClass="tight">
            <table className="table">
              <thead><tr><th>Role</th><th>Users</th><th>Permissions</th><th className="actions" /></tr></thead>
              <tbody>
                {roles.map((role) => (
                  <tr key={role.id}>
                    <td><strong>{role.name}</strong><div className="text-xs faint">{role.description}</div></td>
                    <td>{role.userCount}</td>
                    <td>{role.name === "Administrator" ? <Pill tone="green">all</Pill> : role.permissions.length}</td>
                    <td className="actions">
                      <Button size="sm" onClick={() => { setSelected(role); setDraft(role.permissions); }}>Edit</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card title={selected ? `Permissions · ${selected.name}` : "Permissions"} icon={<KeyRound size={12} />}>
            {!selected ? (
              <EmptyState icon={<ShieldCheck size={16} />} title="Select a role" description="Choose a role on the left to review and change its permissions." />
            ) : selected.name === "Administrator" ? (
              <Banner tone="info" title="The Administrator role is immutable">
                Root administrators bypass permission checks by design, so this role cannot be edited.
              </Banner>
            ) : (
              <>
                <div className="stack" style={{ gap: 6, maxHeight: 380, overflowY: "auto" }}>
                  {Object.entries(catalogue).map(([permission, description]) => (
                    <label key={permission} className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={draft.includes(permission)}
                        onChange={(event) => setDraft(event.target.checked ? [...draft, permission] : draft.filter((entry) => entry !== permission))}
                      />
                      <span>
                        <span className="mono text-xs">{permission}</span>
                        <div className="text-xs faint">{description}</div>
                      </span>
                    </label>
                  ))}
                </div>
                <Button
                  variant="primary" style={{ marginTop: 12 }}
                  onClick={async () => {
                    try {
                      await api.patch(`/api/roles/${selected.id}`, { permissions: draft });
                      toast.success("Role updated");
                      await load();
                    } catch (err) { toast.fromError(err, "Could not update role"); }
                  }}
                  disabled={!can("role.manage")}
                >
                  Save permissions
                </Button>
              </>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

/* --------------------------------- Java --------------------------------- */
export function JavaPage() {
  const toast = useToast();
  const { can } = useSession();
  const [data, setData] = useState<any>(null);
  const [installing, setInstalling] = useState<number | null>(null);

  const load = () => api.get<any>("/api/java").then(setData).catch(() => setData(null));
  useEffect(() => { void load(); }, []);

  return (
    <>
      <PageHeader
        title="Java Runtimes"
        icon={<Cpu size={19} />}
        subtitle="Eclipse Temurin runtimes downloaded and verified by RSLMC. No system Java is required."
        actions={<Button icon={<RefreshCw size={14} />} onClick={() => void load()}>Refresh</Button>}
      />
      {!data ? <Loading label="Loading Java runtimes…" /> : (
        <>
          <div className="stat-grid" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
            <StatCard label="Installed runtimes" icon={<Cpu size={11} />} accent="var(--green)" value={data.data.length} meta={<span>{formatBytes(data.data.reduce((sum: number, runtime: any) => sum + runtime.sizeBytes, 0))} on disk</span>} />
            <StatCard label="Kernel limits" icon={<ShieldCheck size={11} />} accent="var(--blue)" value={data.cgroups.privileged ? "enforced" : "advisory"} meta={<span>{data.cgroups.reason.slice(0, 60)}…</span>} />
            <StatCard label="Upstream majors" icon={<Download size={11} />} accent="var(--amber)" value={data.availableUpstream.length} meta={<span>published by Adoptium</span>} />
          </div>

          <Card title="Installed" icon={<Cpu size={12} />} bodyClass="tight">
            {data.data.length === 0 ? (
              <EmptyState icon={<Cpu size={17} />} title="No runtimes installed" description="Runtimes are downloaded automatically when a server needs them, or install one now." />
            ) : (
              <table className="table">
                <thead><tr><th>Major</th><th>Version</th><th>Vendor</th><th>Platform</th><th>Size</th><th>Status</th><th>Last used</th><th className="actions" /></tr></thead>
                <tbody>
                  {data.data.map((runtime: any) => (
                    <tr key={runtime.id}>
                      <td><strong>Java {runtime.major}</strong></td>
                      <td className="mono text-xs">{runtime.version}</td>
                      <td className="text-xs">{runtime.vendor}</td>
                      <td className="text-xs">{runtime.os} {runtime.arch}</td>
                      <td>{formatBytes(runtime.sizeBytes)}</td>
                      <td><Pill tone={runtime.status === "verified" ? "green" : runtime.status === "failed" ? "red" : "amber"}>{runtime.status}</Pill></td>
                      <td className="text-xs">{runtime.lastUsedAt ? relativeTime(runtime.lastUsedAt) : "never"}</td>
                      <td className="actions">
                        <Button
                          size="sm" variant="danger" icon={<Trash2 size={12} />}
                          onClick={async () => {
                            try {
                              await api.delete(`/api/java/${runtime.id}`);
                              toast.success("Runtime removed");
                              await load();
                            } catch (err) { toast.fromError(err, "Could not remove runtime"); }
                          }}
                          disabled={!can("java.manage")}
                        >
                          Remove
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Install a runtime" icon={<Download size={12} />}>
            <div className="text-xs faint" style={{ marginBottom: 10 }}>
              Downloads the official Eclipse Temurin JDK, verifies the SHA-256 checksum, extracts it atomically and confirms the runtime reports the expected major version.
            </div>
            <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
              {data.supportedMajors.map((major: number) => (
                <Button
                  key={major}
                  size="sm"
                  loading={installing === major}
                  disabled={!can("java.manage") || data.data.some((runtime: any) => runtime.major === major)}
                  onClick={async () => {
                    setInstalling(major);
                    try {
                      await api.post("/api/java/install", { major });
                      toast.success(`Java ${major} installed`);
                      await load();
                    } catch (err) { toast.fromError(err, `Could not install Java ${major}`); }
                    finally { setInstalling(null); }
                  }}
                >
                  Java {major}
                </Button>
              ))}
            </div>
          </Card>
        </>
      )}
    </>
  );
}

/* --------------------------------- Audit -------------------------------- */
export function AuditPage() {
  const [data, setData] = useState<any>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");

  const load = () => api.get<any>(`/api/audit?page=${page}&perPage=40&search=${encodeURIComponent(search)}`).then(setData).catch(() => setData({ items: [], total: 0, totalPages: 1 }));
  useEffect(() => { void load(); }, [page]);

  return (
    <>
      <PageHeader
        title="Audit Log"
        icon={<ScrollText size={19} />}
        subtitle="Security-sensitive actions, with secrets redacted before storage."
        actions={<div className="row" style={{ gap: 6 }}>
          <Input placeholder="Search…" value={search} onChange={(event) => setSearch(event.target.value)} style={{ width: 190, height: 28 }} />
          <Button icon={<RefreshCw size={13} />} onClick={() => { setPage(1); void load(); }}>Search</Button>
        </div>}
      />
      {!data ? <Loading label="Loading audit log…" /> : (
        <Card title={`${data.total} entries`} icon={<ScrollText size={12} />} bodyClass="tight">
          <table className="table">
            <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>IP</th><th>Result</th></tr></thead>
            <tbody>
              {data.items.map((entry: any) => (
                <tr key={entry.id}>
                  <td className="text-xs nowrap">{formatDateTime(entry.ts)}</td>
                  <td className="text-xs">{entry.actorName ?? "system"}</td>
                  <td className="mono text-xs">{entry.action}</td>
                  <td className="text-xs">{entry.targetType ?? ""}{entry.targetId ? ` #${entry.targetId}` : ""}</td>
                  <td className="mono text-xs">{entry.ip ?? "—"}</td>
                  <td><Pill tone={entry.result === "failure" ? "red" : "green"}>{entry.result}</Pill></td>
                </tr>
              ))}
              {data.items.length === 0 ? <tr><td colSpan={6} className="faint text-xs">No audit entries.</td></tr> : null}
            </tbody>
          </table>
          <div className="row" style={{ padding: "10px 14px", borderTop: "1px solid var(--border)" }}>
            <span className="text-xs faint">Page {page} of {data.totalPages}</span>
            <span className="spacer" />
            <Button size="sm" onClick={() => setPage(Math.max(1, page - 1))} disabled={page === 1}>Previous</Button>
            <Button size="sm" onClick={() => setPage(page + 1)} disabled={page >= data.totalPages}>Next</Button>
          </div>
        </Card>
      )}
    </>
  );
}

/* --------------------------------- System ------------------------------- */
export function SystemPage() {
  const toast = useToast();
  const { can } = useSession();
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.get<any>("/api/system").then(setData).catch(() => setData(null));
  useEffect(() => { void load(); }, []);

  if (!data) return <Loading label="Loading system information…" minHeight={280} />;

  return (
    <>
      <PageHeader
        title="System"
        icon={<Gauge size={19} />}
        subtitle={`RSLMC ${data.panel.version} · ${data.panel.mode} mode · Bun ${data.panel.bunVersion}`}
        actions={<Button icon={<RefreshCw size={14} />} onClick={() => void load()}>Refresh</Button>}
      />

      <div className="grid grid-2">
        <Card title="Runtime" icon={<Terminal size={12} />} bodyClass="tight">
          <InfoList
            rows={[
              { key: "Panel version", value: data.panel.version },
              { key: "Mode", value: <Pill tone={data.panel.mode === "production" ? "green" : "amber"}>{data.panel.mode}</Pill> },
              { key: "Listening port", value: data.panel.port },
              { key: "Uptime", value: formatDuration(data.panel.uptimeSeconds) },
              {
                key: "Data directory",
                value: (
                  <span className="row" style={{ gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    <span className="mono text-xs">{data.panel.dataDir}</span>
                    <Pill tone={data.panel.dataDirSource === "platform-default" ? "green" : data.panel.dataDirSource === "env" ? "blue" : data.panel.dataDirSource === "existing-install" ? "violet" : "amber"}>
                      {data.panel.dataDirSource === "platform-default" ? "platform default"
                        : data.panel.dataDirSource === "env" ? "RSLMC_DATA_DIR"
                        : data.panel.dataDirSource === "existing-install" ? "existing install (in place)"
                        : "local fallback"}
                    </Pill>
                  </span>
                ),
              },
              { key: "Bun", value: data.panel.bunVersion },
              { key: "Managed processes", value: data.managedProcesses.length },
            ]}
          />
        </Card>

        <Card title="Host" icon={<Cpu size={12} />} bodyClass="tight">
          <InfoList
            rows={[
              { key: "OS", value: `${data.host.os} (${data.host.arch})` },
              { key: "CPU", value: `${data.host.cpuCores} cores · ${data.host.cpuUsagePercent.toFixed(1)}% used` },
              { key: "Memory", value: `${formatBytes(data.host.memoryUsedBytes)} / ${formatBytes(data.host.memoryTotalBytes)}` },
              { key: "Disk", value: `${formatBytes(data.host.diskUsedBytes)} / ${formatBytes(data.host.diskTotalBytes)}` },
              { key: "Load average", value: data.host.loadAverage.map((value: number) => value.toFixed(2)).join(" · ") },
              { key: "System Java", value: data.host.javaVersion ?? "not installed (not required)" },
            ]}
          />
        </Card>

        <Card title="Resource enforcement" icon={<ShieldCheck size={12} />} bodyClass="tight">
          <InfoList
            rows={[
              { key: "Memory", value: <Pill tone={data.enforcement.memory.level === "enforced" ? "green" : "amber"}>{data.enforcement.memory.level} — {data.enforcement.memory.mechanism}</Pill> },
              { key: "CPU", value: <Pill tone={data.enforcement.cpu.level === "enforced" ? "green" : "amber"}>{data.enforcement.cpu.level} — {data.enforcement.cpu.mechanism}</Pill> },
              { key: "Disk", value: <Pill tone={data.enforcement.disk.level === "enforced" ? "green" : "amber"}>{data.enforcement.disk.level} — {data.enforcement.disk.mechanism}</Pill> },
              { key: "cgroup v2", value: data.cgroups.version === 2 ? "detected" : "not detected" },
              { key: "Helper installed", value: data.cgroups.helperInstalled ? "yes" : "no" },
            ]}
          />
          <div style={{ padding: "10px 14px", borderTop: "1px solid var(--border)" }}>
            <div className="text-xs faint" style={{ lineHeight: 1.6 }}>{data.enforcement.memory.note}</div>
            {data.cgroups.version === 2 && !data.cgroups.privileged ? (
              <Button
                size="sm" style={{ marginTop: 8 }} loading={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const result = await api.post<{ ok: boolean; message: string }>("/api/system/cgroups/install");
                    if (result.ok) toast.success("Helper installed", result.message);
                    else toast.error("Could not install helper", result.message);
                    await load();
                  } catch (err) { toast.fromError(err, "Could not install the cgroup helper"); }
                  finally { setBusy(false); }
                }}
                disabled={!can("system.manage")}
              >
                Install privileged cgroup helper
              </Button>
            ) : null}
          </div>
        </Card>

        <Card title="Maintenance" icon={<Activity size={12} />}>
          <div className="stack" style={{ gap: 8 }}>
            {[
              { task: "prune-metrics", label: "Prune old metrics" },
              { task: "backup-database", label: "Snapshot the panel database" },
              { task: "checkpoint", label: "Checkpoint the SQLite WAL" },
              { task: "reload-scheduler", label: "Reload the scheduler" },
            ].map((entry) => (
              <div className="row" key={entry.task}>
                <span className="text-sm">{entry.label}</span>
                <span className="spacer" />
                <Button
                  size="sm"
                  onClick={async () => {
                    try {
                      const result = await api.post<{ message: string }>("/api/system/maintenance", { task: entry.task });
                      toast.success("Done", result.message);
                    } catch (err) { toast.fromError(err, "Maintenance task failed"); }
                  }}
                  disabled={!can("system.manage")}
                >
                  Run
                </Button>
              </div>
            ))}
            <div className="divider" />
            <div className="text-xs faint">
              Backups: {data.backups.count} archive(s), {formatBytes(data.backups.totalBytes)} in <span className="mono">{data.backups.directory}</span>
            </div>
          </div>
        </Card>
      </div>

      <Card title="Configuration keys" icon={<Info size={12} />} bodyClass="tight">
        <table className="table">
          <thead><tr><th>Key</th><th>Secret</th><th>Updated</th></tr></thead>
          <tbody>
            {data.settings.map((setting: any) => (
              <tr key={setting.key}>
                <td className="mono text-xs">{setting.key}</td>
                <td>{setting.secret ? <Pill tone="amber">redacted</Pill> : <Pill tone="neutral">plain</Pill>}</td>
                <td className="text-xs">{relativeTime(setting.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

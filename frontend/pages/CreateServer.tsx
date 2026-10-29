import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft, ArrowRight, Check, Cpu, Download, Globe2, HardDrive, MemoryStick, Package,
  Rocket, Server, Settings2, ShieldAlert, Users2,
} from "lucide-react";
import type { ServerSoftwareId, SoftwareDefinition } from "../../src/shared/types";
import { heapMbFor, overheadMbFor, initialHeapMbFor, allocationAdvice } from "../../src/shared/memory";
import { Banner, Button, Card, Field, Input, PageHeader, Pill, Select, Toggle } from "../components/ui";
import { api, errorMessage } from "../lib/api";
import { useSession, useToast } from "../lib/app";
import { useRouter } from "../lib/router";
import { cpuAllocationLabel } from "../lib/format";

interface VersionInfo { id: string; type: string; javaMajor: number }
interface NodeInfo { id: number; name: string; isLocal: boolean; online: boolean; maintenance: boolean }

const STEPS = [
  { id: 1, label: "Basics", icon: <Server size={13} /> },
  { id: 2, label: "Software", icon: <Package size={13} /> },
  { id: 3, label: "Networking", icon: <Globe2 size={13} /> },
  { id: 4, label: "Resources", icon: <Cpu size={13} /> },
  { id: 5, label: "Review", icon: <Rocket size={13} /> },
];

export function CreateServerPage() {
  const { user, can } = useSession();
  const toast = useToast();
  const { navigate } = useRouter();

  const [step, setStep] = useState(1);
  const [catalog, setCatalog] = useState<SoftwareDefinition[]>([]);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [users, setUsers] = useState<{ id: number; username: string }[]>([]);
  const [versions, setVersions] = useState<VersionInfo[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [includeExperimental, setIncludeExperimental] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installInfo, setInstallInfo] = useState<{ id: string; label: string; progress: number; total: number; done: boolean; error?: string } | null>(null);

  const selectedNode = nodes.find((node) => node.id === form.nodeId) ?? null;

  const [form, setForm] = useState({
    name: "", description: "", ownerId: 0, nodeId: 0,
    software: "paper" as ServerSoftwareId, mcVersion: "", javaMajor: 0,
    bindIp: "0.0.0.0", port: 25565,
    publicHost: "", publicPort: "",
    memoryMb: 2048, cpuPercent: 100, diskMb: 10240,   // CPU default widens to all host cores on load
    jvmArgs: "", serverArgs: "nogui", autoStart: false, crashRecovery: true, acceptEula: false,
  });

  useEffect(() => {
    // "Full power" default: an allocation of 100 % is a single core, which throttles Minecraft.
    // Start at cores × 100 % so a fresh server may use the whole machine, and let the user cap it.
    // Memory default: leave the machine usable for the OS, the panel and the other servers. Half of
    // the host's RAM (rounded to 256 MB, between 1 GB and 4 GB) instead of a flat 2 GB that could
    // exceed a small box; the field stays editable and the hint spells the numbers out.
    api.get<{ cpuCores: number; memoryTotalBytes: number }>("/api/system/host")
      .then((host) => {
        const cores = Math.max(1, Math.min(16, host.cpuCores || 1));
        const halfGb = (host.memoryTotalBytes || 0) / 1024 ** 3 / 2;
        const suggested = Math.min(4096, Math.max(1024, Math.round((halfGb * 1024) / 256) * 256));
        setForm((current) => ({
          ...current,
          cpuPercent: current.cpuPercent === 100 ? cores * 100 : current.cpuPercent,
          memoryMb: current.memoryMb === 2048 ? suggested : current.memoryMb,
        }));
      })
      .catch(() => {});
    api.get<{ data: SoftwareDefinition[] }>("/api/software").then((result) => setCatalog(result.data)).catch(() => {});
    api.get<{ data: NodeInfo[] }>("/api/nodes").then((result) => {
      setNodes(result.data);
      const local = result.data.find((node) => node.isLocal) ?? result.data[0];
      if (local) setForm((current) => ({ ...current, nodeId: local.id }));
    }).catch(() => {});
    api.get<{ data: { id: number; username: string }[] }>("/api/users").then((result) => {
      setUsers(result.data);
      if (user) setForm((current) => ({ ...current, ownerId: current.ownerId || user.id }));
    }).catch(() => {
      if (user) setForm((current) => ({ ...current, ownerId: current.ownerId || user.id }));
    });
  }, []);

  useEffect(() => {
    if (!form.software) return;
    setVersionsLoading(true);
    api.get<{ data: VersionInfo[] }>(`/api/software/${form.software}/versions?experimental=${includeExperimental}`)
      .then((result) => {
        setVersions(result.data);
        setForm((current) => {
          if (current.mcVersion && result.data.some((version) => version.id === current.mcVersion)) return current;
          const first = result.data[0];
          return first ? { ...current, mcVersion: first.id, javaMajor: first.javaMajor } : current;
        });
      })
      .catch((err) => toast.fromError(err, "Could not load versions for this software"))
      .finally(() => setVersionsLoading(false));
  }, [form.software, includeExperimental]);

  const selectedSoftware = useMemo(() => catalog.find((item) => item.id === form.software), [catalog, form.software]);
  const selectedVersion = useMemo(() => versions.find((version) => version.id === form.mcVersion), [versions, form.mcVersion]);

  useEffect(() => {
    if (selectedVersion && (!form.javaMajor || form.javaMajor < selectedVersion.javaMajor)) {
      setForm((current) => ({ ...current, javaMajor: selectedVersion.javaMajor }));
    }
  }, [selectedVersion]);

  const canSubmit = form.name.trim().length >= 2 && form.mcVersion && form.acceptEula && form.ownerId > 0 && form.nodeId > 0;

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.post<{ server: { id: number; name: string }; installId: string }>("/api/servers", {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        ownerId: form.ownerId,
        nodeId: form.nodeId,
        software: form.software,
        mcVersion: form.mcVersion,
        memoryMb: Number(form.memoryMb),
        cpuPercent: Number(form.cpuPercent),
        diskMb: Number(form.diskMb),
        bindIp: form.bindIp,
        publicHost: form.publicHost.trim() || undefined,
        publicPort: form.publicPort.trim() ? Number(form.publicPort) : undefined,
        port: Number(form.port),
        javaMajor: form.javaMajor || undefined,
        jvmArgs: form.jvmArgs,
        serverArgs: form.serverArgs,
        autoStart: form.autoStart,
        crashRecovery: form.crashRecovery,
        acceptEula: form.acceptEula,
      });
      setInstallInfo({ id: result.installId, label: "Queued — downloading Java runtime and server software", progress: 0, total: 0, done: false });
      toast.success("Server created", "Installation started in the background.");
      setTimeout(() => navigate(`/servers/${result.server.id}/overview`), 900);
    } catch (err) {
      setError(errorMessage(err));
      toast.fromError(err, "Could not create the server");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Create a server"
        icon={<Rocket size={19} />}
        subtitle="RSLMC downloads the exact Java runtime and server software your selection needs — nothing is pre-installed on the host."
        actions={<Button icon={<ArrowLeft size={14} />} onClick={() => navigate("/dashboard")}>Back</Button>}
      />

      <div className="row" style={{ gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {STEPS.map((entry) => (
          <button
            key={entry.id}
            className={`tab ${step === entry.id ? "active" : ""}`}
            onClick={() => setStep(entry.id)}
            style={{ opacity: step >= entry.id ? 1 : 0.65 }}
          >
            {step > entry.id ? <Check size={12} /> : entry.icon}
            {entry.label}
          </button>
        ))}
      </div>

      {error ? <Banner tone="error" title="Server creation failed">{error}</Banner> : null}

      {step === 1 ? (
        <Card title="Basic details" icon={<Server size={12} />}>
          <div className="form-grid">
            <Field label="Server name" required hint="Shown throughout the panel and as the default MOTD." className="span-2">
              <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Survival SMP" maxLength={60} autoFocus />
            </Field>
            <Field label="Description" className="span-2">
              <Input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="What is this server for?" maxLength={300} />
            </Field>
            <Field label="Owner" required>
              <Select value={form.ownerId} onChange={(event) => setForm({ ...form, ownerId: Number(event.target.value) })}>
                <option value={0}>Select a user…</option>
                {users.map((entry) => <option key={entry.id} value={entry.id}>{entry.username}</option>)}
              </Select>
            </Field>
            <Field
              label="Node"
              required
              hint={
                selectedNode && !selectedNode.online
                  ? "That node is not answering — its servers cannot be created or started until it is back."
                  : "The machine that will run this server. The local node is this panel."
              }
            >
              <Select value={form.nodeId} onChange={(event) => setForm({ ...form, nodeId: Number(event.target.value) })}>
                {nodes.map((node) => (
                  <option key={node.id} value={node.id} disabled={!node.isLocal && !node.online}>
                    {node.name}{node.isLocal ? " (local)" : ""}{node.online ? "" : " — offline"}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </Card>
      ) : null}

      {step === 2 ? (
        <Card
          title="Server software"
          icon={<Package size={12} />}
          actions={
            <Toggle checked={includeExperimental} onChange={setIncludeExperimental} label="Show snapshots / pre-releases" />
          }
        >
          <div className="grid grid-3" style={{ gap: 9 }}>
            {catalog.map((item) => (
              <button
                key={item.id}
                onClick={() => setForm({ ...form, software: item.id, mcVersion: "" })}
                className="card"
                style={{
                  textAlign: "left", cursor: "pointer", padding: 12,
                  borderColor: form.software === item.id ? "rgba(62,207,114,0.5)" : "var(--border)",
                  background: form.software === item.id ? "rgba(62,207,114,0.05)" : "var(--surface)",
                }}
              >
                <div className="row">
                  <strong style={{ fontSize: 13 }}>{item.name}</strong>
                  <span className="spacer" />
                  <Pill tone={item.proxy ? "violet" : item.kind === "mod" ? "blue" : "green"}>{item.proxy ? "proxy" : item.kind}</Pill>
                </div>
                <p className="text-xs faint" style={{ margin: "6px 0 0", lineHeight: 1.5 }}>{item.description}</p>
                <div className="row text-xs faint" style={{ marginTop: 8, gap: 8 }}>
                  <span>{item.supportsPlugins ? "plugins" : ""}</span>
                  <span>{item.supportsMods ? "mods" : ""}</span>
                  <span className="spacer" />
                  <span className="mono">{item.source}</span>
                </div>
              </button>
            ))}
          </div>

          <div className="form-grid" style={{ marginTop: 14 }}>
            <Field label={`Minecraft version${versionsLoading ? " — loading…" : ""}`} required hint={selectedSoftware ? `Source: ${selectedSoftware.source}` : undefined}>
              <Select value={form.mcVersion} onChange={(event) => {
                const version = versions.find((entry) => entry.id === event.target.value);
                setForm({ ...form, mcVersion: event.target.value, javaMajor: version?.javaMajor ?? form.javaMajor });
              }}>
                {versions.length === 0 ? <option value="">No versions available</option> : null}
                {versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    {version.id} — Java {version.javaMajor}{version.type !== "release" ? ` (${version.type})` : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Java runtime" hint="RSLMC downloads this exact Temurin major when the server is created.">
              <Select value={form.javaMajor} onChange={(event) => setForm({ ...form, javaMajor: Number(event.target.value) })}>
                {[8, 11, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25].map((major) => (
                  <option key={major} value={major}>Java {major}{selectedVersion && major === selectedVersion.javaMajor ? " (recommended)" : ""}</option>
                ))}
              </Select>
            </Field>
          </div>

          {selectedVersion && form.javaMajor < selectedVersion.javaMajor ? (
            <Banner tone="warning" title="Java version below the requirement">
              {selectedSoftware?.name} {selectedVersion.id} expects Java {selectedVersion.javaMajor} or newer. The server will probably fail to start with Java {form.javaMajor}.
            </Banner>
          ) : null}
          {selectedSoftware?.installerBased ? (
            <Banner tone="info" title="Installer-based software">
              {selectedSoftware.name} is installed by running its official installer with the managed Java runtime. The download and installer output is streamed to the server console.
            </Banner>
          ) : null}
        </Card>
      ) : null}

      {step === 3 ? (
        <Card title="Networking" icon={<Globe2 size={12} />}>
          <div className="form-grid">
            <Field label="Bind address" hint="0.0.0.0 listens on every interface. 127.0.0.1 is only reachable from this machine.">
              <Input value={form.bindIp} onChange={(event) => setForm({ ...form, bindIp: event.target.value })} placeholder="0.0.0.0" />
            </Field>
            <Field label="Server port" required hint="Validated for conflicts before the server is created.">
              <Input type="number" min={1} max={65535} value={form.port} onChange={(event) => setForm({ ...form, port: Number(event.target.value) })} />
            </Field>
            {/* Same size, directly under the bind address / port pair: what players actually type. */}
            <Field label="Public domain" hint="Optional — playit.gg, ngrok, FRP… Leave empty to show the address above.">
              <Input
                placeholder="something.playit.gg"
                value={form.publicHost}
                onChange={(event) => setForm({ ...form, publicHost: event.target.value })}
              />
            </Field>
            <Field label="Public port" hint="Optional — leave empty for tunnels that use the default port (the address is then shown without a port).">
              <Input
                type="number" min={1} max={65535} placeholder="default"
                value={form.publicPort}
                onChange={(event) => setForm({ ...form, publicPort: event.target.value })}
              />
            </Field>
          </div>
          <Banner tone="info" title="Reachability">
            RSLMC verifies that the port is free on this host. Whether it is reachable from the internet depends on your firewall and port forwarding — the panel reports those separately on the Networking page.
            {form.publicHost.trim() ? (
              <> Players will be shown <span className="mono">{form.publicHost.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "")}{form.publicPort.trim() ? `:${form.publicPort.trim()}` : ""}</span> instead of the internal address.</>
            ) : null}
          </Banner>
        </Card>
      ) : null}

      {step === 4 ? (
        <Card title="Resources" icon={<Cpu size={12} />}>
          <div className="form-grid">
            <Field label="Memory" hint={`Hard cap for the whole process, minimum 128 MB. The Java heap grows up to ${heapMbFor(Number(form.memoryMb) || 0)} MB, starts at ${initialHeapMbFor(Number(form.memoryMb) || 0)} MB, and ${overheadMbFor(Number(form.memoryMb) || 0)} MB is kept for JVM runtime overhead.${allocationAdvice(Number(form.memoryMb) || 0) ? ` ${allocationAdvice(Number(form.memoryMb) || 0)}` : ""}`}>
              <div className="inline-group">
                <Input type="number" min={128} max={65536} step={128} value={form.memoryMb} onChange={(event) => setForm({ ...form, memoryMb: Number(event.target.value) })} />
                <span className="text-xs faint">MB</span>
              </div>
            </Field>
            <Field label="CPU allocation" hint={cpuAllocationLabel(form.cpuPercent)}>
              <Input type="number" min={10} max={1600} step={10} value={form.cpuPercent} onChange={(event) => setForm({ ...form, cpuPercent: Number(event.target.value) })} />
            </Field>
            <Field label="Disk target" hint="A soft limit used for warnings unless the host filesystem supports real quotas.">
              <div className="inline-group">
                <Input type="number" min={512} max={1048576} step={512} value={form.diskMb} onChange={(event) => setForm({ ...form, diskMb: Number(event.target.value) })} />
                <span className="text-xs faint">MB</span>
              </div>
            </Field>
            <Field label="Server arguments" hint="Passed after the jar. Use nogui for headless operation.">
              <Input value={form.serverArgs} onChange={(event) => setForm({ ...form, serverArgs: event.target.value })} />
            </Field>
            <Field
              label="Extra JVM arguments"
              className="span-2"
              hint="Leave empty to get the optimised preset for this software: Aikar's G1GC flags for game servers, the small G1GC proxy set for Velocity/BungeeCord, SerialGC on ≤1 GB heaps. Anything you type here replaces the preset."
            >
              <Input value={form.jvmArgs} onChange={(event) => setForm({ ...form, jvmArgs: event.target.value })} placeholder="Aikar's flags (recommended · default)" />
            </Field>
          </div>
        </Card>
      ) : null}

      {step === 5 ? (
        <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)" }}>
          <Card title="Review" icon={<Check size={12} />} bodyClass="tight">
            <div className="info-list">
              <div className="info-row"><span className="k">Name</span><span className="v">{form.name || "—"}</span></div>
              <div className="info-row"><span className="k">Software</span><span className="v">{selectedSoftware?.name} {form.mcVersion}</span></div>
              <div className="info-row"><span className="k">Java</span><span className="v">Temurin {form.javaMajor}</span></div>
              <div className="info-row"><span className="k">Node</span><span className="v">{nodes.find((node) => node.id === form.nodeId)?.name ?? "—"}</span></div>
              <div className="info-row"><span className="k">Address</span><span className="v mono">{form.bindIp}:{form.port}</span></div>
              <div className="info-row"><span className="k">Memory</span><span className="v">{form.memoryMb} MB</span></div>
              <div className="info-row"><span className="k">CPU</span><span className="v">{cpuAllocationLabel(form.cpuPercent)}</span></div>
              <div className="info-row"><span className="k">Disk target</span><span className="v">{form.diskMb} MB</span></div>
              <div className="info-row"><span className="k">Auto-start</span><span className="v">{form.autoStart ? "Yes" : "No"}</span></div>
              <div className="info-row"><span className="k">Crash recovery</span><span className="v">{form.crashRecovery ? "Restart automatically" : "Off"}</span></div>
            </div>
          </Card>
          <div className="stack">
            <Card title="Before you continue" icon={<ShieldAlert size={12} />}>
              <label className="checkbox-row">
                <input type="checkbox" checked={form.acceptEula} onChange={(event) => setForm({ ...form, acceptEula: event.target.checked })} />
                <span>
                  I accept the <a href="https://www.minecraft.net/eula" target="_blank" rel="noreferrer noopener" style={{ textDecoration: "underline" }}>Minecraft End User Licence Agreement</a>.
                  RSLMC writes <span className="mono">eula=true</span> only when this box is checked.
                </span>
              </label>
              <div className="divider" style={{ margin: "10px 0" }} />
              <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                <Download size={13} className="faint" style={{ marginTop: 2 }} />
                <span className="text-xs faint">
                  Creation downloads Java {form.javaMajor} (≈ 180 MB) and the server artifact, then verifies checksums. This can take a few minutes.
                </span>
              </div>
              <div className="row" style={{ gap: 8, alignItems: "flex-start", marginTop: 8 }}>
                <HardDrive size={13} className="faint" style={{ marginTop: 2 }} />
                <span className="text-xs faint">Files are stored under <span className="mono">runtime/servers/&lt;uuid&gt;</span>.</span>
              </div>
              <div className="row" style={{ gap: 8, alignItems: "flex-start", marginTop: 8 }}>
                <MemoryStick size={13} className="faint" style={{ marginTop: 2 }} />
                <span className="text-xs faint">Memory/CPU limits are kernel-enforced only where the host supports cgroups v2 with privileged access.</span>
              </div>
            </Card>
            {installInfo ? (
              <Card title="Installation" icon={<Download size={12} />}>
                <div className="row"><span className="text-xs">{installInfo.label}</span></div>
                <div className="progress" style={{ marginTop: 8 }}>
                  <span style={{ width: `${installInfo.total > 0 ? (installInfo.progress / installInfo.total) * 100 : 6}%` }} />
                </div>
              </Card>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="row" style={{ marginTop: 16, gap: 8 }}>
        <Button icon={<ArrowLeft size={14} />} onClick={() => setStep(Math.max(1, step - 1))} disabled={step === 1}>Back</Button>
        <span className="spacer" />
        {step < 5 ? (
          <Button variant="primary" onClick={() => setStep(step + 1)} disabled={step === 1 && form.name.trim().length < 2}>
            Continue <ArrowRight size={14} />
          </Button>
        ) : (
          <Button variant="primary" icon={<Rocket size={14} />} loading={submitting} disabled={!canSubmit || !can("server.create")} onClick={() => void submit()}>
            Create server
          </Button>
        )}
      </div>
      {step === 5 && !form.acceptEula ? <div className="text-xs faint" style={{ marginTop: 8 }}>Accept the EULA to enable server creation.</div> : null}
    </>
  );
}

import { useEffect, useState } from "react";
import { heapMbFor, overheadMbFor, initialHeapMbFor, allocationAdvice } from "../../src/shared/memory";
import { AlertTriangle, Cog, Cpu, Download, KeyRound, MemoryStick, Save, Server, ShieldAlert, Trash2 } from "lucide-react";
import type { ServerSummary } from "../../src/shared/types";
import { Banner, Button, Card, ConfirmDialog, Field, Input, Loading, PageHeader, Pill, Select, Textarea, Toggle } from "../components/ui";
import { api } from "../lib/api";
import { useSession, useToast } from "../lib/app";
import { useRouter } from "../lib/router";
import { cpuAllocationLabel, formatDateTime } from "../lib/format";

interface RuntimeEntry { id: number; major: number; version: string; vendor: string; status: string }

interface JavaState {
  requiredMajor: number;
  runtimeId: number | null;
  pinnedUsable: boolean;
  managedInstalled: boolean;
  managedVersion: string | null;
}

interface SettingsPayload {
  raw: { jvmArgs: string; serverArgs: string; startupCommand: string; javaMajor: number };
  jvmPresets: { id: string; label: string; summary: string; flags: string; recommended?: boolean }[];
  jvmPreset: string;
  runtimes: RuntimeEntry[];
  java?: JavaState;
}

export function SettingsPage({ server }: { server: ServerSummary }) {
  const { can } = useSession();
  const toast = useToast();
  const { navigate } = useRouter();
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [jvmPreset, setJvmPreset] = useState("custom");
  const [java, setJava] = useState<JavaState | null>(null);
  const [installingJava, setInstallingJava] = useState(false);
  const [form, setForm] = useState({
    name: server.name, description: server.description ?? "", memoryMb: server.memoryMb,
    cpuPercent: server.cpuPercent, diskMb: server.diskMb, jvmArgs: "", serverArgs: "nogui",
    autoStart: server.autoStart, crashRecovery: server.crashRecovery, javaRuntimeId: server.javaRuntimeId ?? 0,
  });
  const [saving, setSaving] = useState(false);
  const [reinstallOpen, setReinstallOpen] = useState(false);
  const [preserveData, setPreserveData] = useState(true);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [deleteBackups, setDeleteBackups] = useState(false);

  const load = async () => {
    const result = await api.get<SettingsPayload>(`/api/servers/${server.id}/settings`);
    setData(result);
    setJava(result.java ?? null);
    setJvmPreset(result.jvmPreset ?? "custom");
    setForm((current) => ({
      ...current,
      jvmArgs: result.raw.jvmArgs ?? "",
      serverArgs: result.raw.serverArgs ?? "nogui",
      // A pinned runtime whose files are gone cannot be rendered as a valid <select> value — fall
      // back to managed and let the warning below explain what happened.
      javaRuntimeId: result.java && result.java.runtimeId && !result.java.pinnedUsable ? 0 : (result.java?.runtimeId ?? 0),
    }));
  };

  useEffect(() => { void load().catch(() => {}); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [server.id]);

  /** Presets write their flags straight into the editable field — nothing hidden, always visible. */
  const applyPreset = (id: string) => {
    setJvmPreset(id);
    const preset = data?.jvmPresets?.find((entry) => entry.id === id);
    if (preset && id !== "custom") setForm((current) => ({ ...current, jvmArgs: preset.flags }));
  };

  const save = async () => {
    setSaving(true);
    try {
      const result = await api.patch<{ server: ServerSummary; warnings?: string[] }>(`/api/servers/${server.id}`, {
        name: form.name, description: form.description, memoryMb: Number(form.memoryMb),
        cpuPercent: Number(form.cpuPercent), diskMb: Number(form.diskMb), jvmArgs: form.jvmArgs,
        serverArgs: form.serverArgs, autoStart: form.autoStart, crashRecovery: form.crashRecovery,
        javaRuntimeId: Number(form.javaRuntimeId) || 0,
      });
      await load().catch(() => {});
      if (result.warnings && result.warnings.length > 0) {
        toast.warn("Settings saved", result.warnings.join(" "));
      } else {
        toast.success("Settings saved", "Restart the server for startup changes to take effect.");
      }
    } catch (err) {
      toast.fromError(err, "Could not save settings");
    } finally {
      setSaving(false);
    }
  };

  const installJava = async () => {
    setInstallingJava(true);
    try {
      await api.post("/api/java/install", { major: java?.requiredMajor ?? data?.raw.javaMajor });
      await load().catch(() => {});
      toast.success("Java installed", `Eclipse Temurin ${java?.requiredMajor ?? data?.raw.javaMajor} is ready for this server.`);
    } catch (err) {
      toast.fromError(err, "Could not install Java");
    } finally {
      setInstallingJava(false);
    }
  };

  const exportConfig = async () => {
    const blob = new Blob([JSON.stringify({ server, settings: form }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${server.name.replace(/\s+/g, "-")}-config.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success("Configuration exported");
  };

  if (!data) return <Loading label="Loading server settings…" minHeight={280} />;

  return (
    <>
      <PageHeader
        title="Settings"
        icon={<Cog size={19} />}
        subtitle={<>Configuration for <strong style={{ color: "var(--text)" }}>{server.name}</strong> · created {formatDateTime(server.createdAt)}</>}
        actions={
          <>
            <Button icon={<Download size={14} />} onClick={() => void exportConfig()}>Export config</Button>
            <Button variant="primary" icon={<Save size={14} />} loading={saving} onClick={() => void save()} disabled={!can("server.settings")}>Save changes</Button>
          </>
        }
      />

      <div className="grid grid-2">
        <Card title="Identity" icon={<Server size={12} />}>
          <div className="form-grid">
            <Field label="Server name" className="span-2" required>
              <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} maxLength={60} />
            </Field>
            <Field label="Description" className="span-2">
              <Textarea rows={2} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} maxLength={500} />
            </Field>
            <Field label="UUID" hint="Immutable identifier used on disk and in the API.">
              <Input value={server.uuid} readOnly className="input mono" />
            </Field>
            <Field label="Node">
              <Input value={server.nodeName ?? "—"} readOnly />
            </Field>
          </div>
        </Card>

        <Card title="Resources" icon={<MemoryStick size={12} />}>
          <div className="form-grid">
            <Field
              label="Memory (MB)"
              hint={`Hard cap for the whole process, minimum 128 MB. The Java heap grows up to ${heapMbFor(Number(form.memoryMb) || 0)} MB (-Xmx), starting at ${initialHeapMbFor(Number(form.memoryMb) || 0)} MB (-Xms); ${overheadMbFor(Number(form.memoryMb) || 0)} MB is reserved for JVM runtime overhead.${allocationAdvice(Number(form.memoryMb) || 0) ? ` ${allocationAdvice(Number(form.memoryMb) || 0)}` : ""}`}
            >
              <Input type="number" min={128} max={65536} step={128} value={form.memoryMb} onChange={(event) => setForm({ ...form, memoryMb: Number(event.target.value) })} />
            </Field>
            <Field label="CPU allocation (%)" hint={cpuAllocationLabel(form.cpuPercent)}>
              <Input type="number" min={10} max={1600} step={10} value={form.cpuPercent} onChange={(event) => setForm({ ...form, cpuPercent: Number(event.target.value) })} />
            </Field>
            <Field label="Disk target (MB)" hint="Soft limit unless the host supports real quotas.">
              <Input type="number" min={512} max={1048576} step={512} value={form.diskMb} onChange={(event) => setForm({ ...form, diskMb: Number(event.target.value) })} />
            </Field>
            <Field
              label="Java runtime"
              hint={java && java.managedInstalled
                ? `Managed: Eclipse Temurin ${java.requiredMajor}${java.managedVersion ? ` (${java.managedVersion})` : ""} is installed and verified.`
                : "Managed: RSLMC installs the required Eclipse Temurin build on first start."}
            >
              <Select value={form.javaRuntimeId} onChange={(event) => setForm({ ...form, javaRuntimeId: Number(event.target.value) })}>
                <option value={0}>Java {java?.requiredMajor ?? data.raw.javaMajor} — managed automatically</option>
                {data.runtimes.map((runtime) => (
                  <option key={runtime.id} value={runtime.id}>Java {runtime.major} · {runtime.version} ({runtime.status})</option>
                ))}
                {form.javaRuntimeId !== 0 && !data.runtimes.some((runtime) => runtime.id === form.javaRuntimeId) ? (
                  <option value={form.javaRuntimeId}>Java runtime #{form.javaRuntimeId} — not on this node</option>
                ) : null}
              </Select>
            </Field>
          </div>
          {java && (!java.managedInstalled || (java.runtimeId !== null && !java.pinnedUsable)) ? (
            <div className="java-note">
              <ShieldAlert size={13} color="var(--amber)" />
              <div>
                {java.runtimeId !== null && !java.pinnedUsable ? (
                  <span>
                    The pinned Java runtime (#{java.runtimeId}) is no longer usable on this node. The selection above is back on
                    <strong> managed automatically</strong>; a fresh Eclipse Temurin {java.requiredMajor} is downloaded when the server starts.
                  </span>
                ) : (
                  <span>
                    Eclipse Temurin {java.requiredMajor} is not installed on this node yet. RSLMC downloads, checksum-verifies and extracts it
                    automatically the first time this server starts — or install it now.
                  </span>
                )}
                <div className="row" style={{ gap: 8, marginTop: 8 }}>
                  <Button size="sm" icon={<Download size={12} />} loading={installingJava} disabled={!can("java.manage")} onClick={() => void installJava()}>
                    Install Java {java.requiredMajor} now
                  </Button>
                  {!can("java.manage") ? <span className="text-xs faint">Needs the java.manage permission.</span> : null}
                </div>
              </div>
            </div>
          ) : null}
          <div className="divider" style={{ margin: "12px 0" }} />
          <div className="stack" style={{ gap: 10 }}>
            <Toggle checked={form.autoStart} onChange={(value) => setForm({ ...form, autoStart: value })} label="Start this server when the panel starts" />
            <Toggle checked={form.crashRecovery} onChange={(value) => setForm({ ...form, crashRecovery: value })} label="Restart automatically after a crash" />
          </div>
        </Card>

        <Card title="Startup" icon={<Cpu size={12} />}>
          <div className="stack">
            <Field
              label="JVM flag preset"
              hint={data.jvmPresets.find((entry) => entry.id === jvmPreset)?.summary
                ?? "RSLMC adds -Xms/-Xmx from the memory allocation and these flags after it."}
            >
              <div className="row" style={{ gap: 8 }}>
                <Select value={jvmPreset} onChange={(event) => applyPreset(event.target.value)}>
                  {data.jvmPresets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.recommended ? "★ " : ""}{preset.label}
                    </option>
                  ))}
                </Select>
                <Button
                  size="sm"
                  onClick={() => applyPreset(data.jvmPresets.find((preset) => preset.recommended)?.id ?? "aikar")}
                  title="Fill the field with the recommended tuned flags"
                >
                  Use recommended
                </Button>
              </div>
            </Field>
            <Field label="Extra JVM arguments" hint="Applied after -Xms/-Xmx. Editing this by hand switches the preset to Custom; nothing is overwritten on save. Do not put -Xms/-Xmx here — the heap size always comes from the memory allocation.">
              <Textarea
                rows={5}
                value={form.jvmArgs}
                onChange={(event) => { setForm({ ...form, jvmArgs: event.target.value }); setJvmPreset("custom"); }}
                placeholder="-XX:+UseG1GC -XX:+ParallelRefProcEnabled …"
              />
            </Field>
            <Field label="Server arguments">
              <Input value={form.serverArgs} onChange={(event) => setForm({ ...form, serverArgs: event.target.value })} />
            </Field>
            <Field label="Effective launch command" hint="Built at start time from the runtime, jar and arguments above.">
              <div className="code-block">{data.raw.startupCommand}</div>
            </Field>
          </div>
        </Card>

        <Card title="Danger zone" icon={<AlertTriangle size={12} />}>
          <div className="stack">
            <div className="row" style={{ alignItems: "flex-start", gap: 10 }}>
              <div style={{ flex: 1 }}>
                <div className="strong text-sm">Reinstall server software</div>
                <div className="text-xs faint">Downloads a fresh copy of {server.software} {server.mcVersion}. World data is preserved unless you choose otherwise.</div>
              </div>
              <Button icon={<Download size={13} />} onClick={() => setReinstallOpen(true)} disabled={!can("server.settings")}>Reinstall</Button>
            </div>
            <div className="divider" />
            <div className="row" style={{ alignItems: "flex-start", gap: 10 }}>
              <div style={{ flex: 1 }}>
                <div className="strong text-sm">Delete this server</div>
                <div className="text-xs faint">Removes the server from the panel. Files and backups are only deleted if you ask for it.</div>
              </div>
              <Button variant="danger" icon={<Trash2 size={13} />} onClick={() => setDeleteOpen(true)} disabled={!can("server.delete")}>Delete server</Button>
            </div>
            <div className="divider" />
            <Banner tone="info" title="Ownership and access">
              Sub-user access is enforced on the backend; every sensitive action checks a permission before it runs.
            </Banner>
          </div>
        </Card>
      </div>

      <ConfirmDialog
        open={reinstallOpen}
        title="Reinstall server software"
        tone="primary"
        confirmLabel="Reinstall now"
        message={
          <div className="stack" style={{ gap: 10 }}>
            <span>The server must be stopped. RSLMC downloads and verifies the artifact again.</span>
            <label className="checkbox-row">
              <input type="checkbox" checked={preserveData} onChange={(event) => setPreserveData(event.target.checked)} />
              <span>Preserve existing world folders</span>
            </label>
          </div>
        }
        onClose={() => setReinstallOpen(false)}
        onConfirm={async () => {
          try {
            await api.post(`/api/servers/${server.id}/reinstall`, { preserveData });
            toast.success("Reinstall started", "Progress is shown on the Overview page.");
            setReinstallOpen(false);
          } catch (err) { toast.fromError(err, "Reinstall failed"); }
        }}
      />

      <ConfirmDialog
        open={deleteOpen}
        title={`Delete ${server.name}?`}
        confirmLabel="Delete server"
        requireText={server.name}
        message={
          <div className="stack" style={{ gap: 10 }}>
            <span>The server is removed from the panel. This cannot be undone.</span>
            <label className="checkbox-row">
              <input type="checkbox" checked={deleteFiles} onChange={(event) => setDeleteFiles(event.target.checked)} />
              <span>Also delete all server files on disk</span>
            </label>
            <label className="checkbox-row">
              <input type="checkbox" checked={deleteBackups} onChange={(event) => setDeleteBackups(event.target.checked)} />
              <span>Also delete all backups</span>
            </label>
          </div>
        }
        onClose={() => setDeleteOpen(false)}
        onConfirm={async () => {
          try {
            await api.delete(`/api/servers/${server.id}`, { confirmName: server.name, deleteFiles, deleteBackups });
            toast.success("Server deleted");
            navigate("/dashboard");
          } catch (err) { toast.fromError(err, "Could not delete server"); }
        }}
      />
    </>
  );
}

const JVM_PRESET_LABELS: Record<string, string> = {
  aikar: "Aikar's flags (G1GC, tuned)",
  proxy: "Proxy tuning (G1GC)",
  lowmem: "Low memory (SerialGC)",
  custom: "Custom",
};

interface StartupOptions {
  software: string;
  mcVersion: string;
  allocationMb: number;
  heapMb: number;
  initialHeapMb: number;
  javaMajor: number;
  current: string;
  currentArgs: string;
  presets: { id: string; label: string; summary: string; recommended: boolean; selectable: boolean; flags: string }[];
  note: string;
}

/**
 * Startup page for accounts that may tune the JVM but not the allocation.
 *
 * Everything that could hurt the host — memory/CPU/disk, the raw flag string, the command line, the
 * port — is shown read-only with the reason, and only a curated preset can be chosen. The heap in
 * the preview comes from the allocation, so it is impossible to "give yourself more RAM" here.
 */
function LimitedStartupCard({ server }: { server: ServerSummary }) {
  const toast = useToast();
  const [options, setOptions] = useState<StartupOptions | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () => api.get<StartupOptions>(`/api/servers/${server.id}/startup-options`)
    .then((result) => { setOptions(result); setDraft(result.current); })
    .catch((err) => toast.fromError(err, "Could not load startup options"));
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [server.id]);

  const selected = options?.presets.find((preset) => preset.id === draft) ?? null;
  const dirty = Boolean(options && draft && draft !== options.current);

  return (
    <Card
      title="Startup options"
      icon={<Cpu size={12} />}
      actions={options ? <Pill tone="neutral">{options.allocationMb} MB allocation</Pill> : null}
    >
      {!options ? <Loading label="Loading startup options…" /> : (
        <div className="stack" style={{ gap: 12 }}>
          <div className="startup-presets">
            {options.presets.filter((preset) => preset.selectable).map((preset) => {
              const active = draft === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  className={`startup-preset ${active ? "active" : ""}`}
                  onClick={() => setDraft(preset.id)}
                >
                  <span className="startup-preset-head">
                    <b>{preset.label}</b>
                    {preset.recommended ? <Pill tone="green">recommended</Pill> : null}
                    {options.current === preset.id ? <Pill tone="blue">active</Pill> : null}
                  </span>
                  <span className="startup-preset-text">{preset.summary}</span>
                </button>
              );
            })}
          </div>

          {selected ? (
            <div>
              <div className="text-xs faint" style={{ marginBottom: 6 }}>Flags that will be used (memory is added from the allocation):</div>
              <div className="code-block" style={{ whiteSpace: "pre-wrap", maxHeight: 132, overflow: "auto" }}>{selected.flags}</div>
            </div>
          ) : null}

          <div className="info-list">
            <div className="info-row"><span className="k">Java heap (from allocation)</span><span className="v">-Xms {options.initialHeapMb} MB · -Xmx {options.heapMb} MB</span></div>
            <div className="info-row"><span className="k">Memory cap</span><span className="v">{options.allocationMb} MB — set by an administrator</span></div>
            <div className="info-row"><span className="k">Java runtime</span><span className="v">Temurin {options.javaMajor}</span></div>
            <div className="info-row"><span className="k">Software</span><span className="v">{options.software} {options.mcVersion}</span></div>
          </div>

          <Banner tone="info" title="What is locked">
            The memory, CPU and disk allocation, the raw JVM flag string, the startup command and the
            port stay with an administrator — changing those affects the host, not just this server.
            A preset only changes GC tuning, and the heap above always follows the allocation.
          </Banner>

          <div className="row" style={{ gap: 8 }}>
            <Button
              variant="primary"
              icon={<Save size={13} />}
              loading={saving}
              disabled={!dirty}
              onClick={async () => {
                if (!draft) return;
                setSaving(true);
                try {
                  const result = await api.put<{ message: string }>(`/api/servers/${server.id}/startup-options`, { preset: draft });
                  toast.success("Startup preset saved", result.message);
                  await load();
                } catch (err) {
                  toast.fromError(err, "Could not save the startup preset");
                } finally {
                  setSaving(false);
                }
              }}
            >
              Save preset
            </Button>
            <Button onClick={() => setDraft(options.current)} disabled={!dirty || saving}>Reset</Button>
            <span className="text-xs faint" style={{ alignSelf: "center" }}>{options.note}</span>
          </div>
        </div>
      )}
    </Card>
  );
}

export function StartupPage({ server }: { server: ServerSummary }) {
  const { can } = useSession();
  const [detail, setDetail] = useState<any>(null);
  useEffect(() => { api.get<any>(`/api/servers/${server.id}`).then(setDetail).catch(() => {}); }, [server.id]);

  // Without full settings access this page becomes the limited editor: presets only, everything
  // else read-only, and nothing that could exceed the allocation.
  if (!can("server.settings")) {
    return (
      <>
        <PageHeader
          title="Startup"
          icon={<KeyRound size={19} />}
          subtitle={<>How <strong style={{ color: "var(--text)" }}>{server.name}</strong> starts · JVM preset only, limits set by an administrator</>}
        />
        <LimitedStartupCard server={server} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Startup"
        icon={<KeyRound size={19} />}
        subtitle={<>How <strong style={{ color: "var(--text)" }}>{server.name}</strong> is launched · generated from your allocation, runtime and arguments</>}
      />
      {!detail ? <Loading label="Loading startup configuration…" /> : (
        <div className="grid grid-2">
          <Card title="Launch configuration" icon={<Cpu size={12} />} bodyClass="tight">
            <div className="info-list">
              <div className="info-row"><span className="k">Software</span><span className="v">{server.software} {server.mcVersion}</span></div>
              <div className="info-row"><span className="k">Java runtime</span><span className="v">{detail.java ? `Temurin ${detail.java.major} · ${detail.java.version}` : `Java ${server.javaMajor} (downloads on start)`}</span></div>
              <div className="info-row"><span className="k">Memory allocation</span><span className="v">{server.memoryMb} MB (process cap)</span></div>
              <div className="info-row"><span className="k">Java heap</span><span className="v">-Xms {detail.jvm?.initialHeapMb ?? "—"} MB · -Xmx {detail.jvm?.heapMb ?? "—"} MB</span></div>
              <div className="info-row"><span className="k">CPU allocation</span><span className="v">{cpuAllocationLabel(server.cpuPercent)}</span></div>
              <div className="info-row"><span className="k">JVM flags</span><span className="v">{JVM_PRESET_LABELS[detail.jvm?.preset ?? "custom"] ?? "Custom"}</span></div>
              <div className="info-row"><span className="k">Process status</span><span className="v">{detail.runtime.status}{detail.runtime.pid ? ` · PID ${detail.runtime.pid}` : ""}</span></div>
              <div className="info-row"><span className="k">Kernel limits</span><span className="v">{detail.runtime.cgroupAttached ? <Pill tone="green">cgroup attached</Pill> : <Pill tone="amber">not attached</Pill>}</span></div>
            </div>
            <div className="divider" style={{ margin: "12px 0" }} />
            <div className="text-xs faint" style={{ marginBottom: 6 }}>
              Flags passed to the JVM (after the -Xms/-Xmx above). Change them under Settings → Startup.
            </div>
            <div className="code-block" style={{ whiteSpace: "pre-wrap", maxHeight: 150, overflow: "auto" }}>
              {detail.jvm?.args ? detail.jvm.args : "No extra flags — the JVM runs with defaults."}
            </div>
          </Card>
          <Card title="Java compatibility" icon={<ShieldAlert size={12} />}>
            <Banner tone={detail.javaCompatibility.ok ? "success" : "warning"} title={detail.javaCompatibility.ok ? "Compatible" : "Incompatible Java version"}>
              {detail.javaCompatibility.note}
            </Banner>
            <div className="stack" style={{ marginTop: 10 }}>
              <div className="text-xs faint">
                Minecraft {server.mcVersion} needs Java {detail.javaCompatibility.required ?? server.javaMajor} or newer. RSLMC downloads Eclipse Temurin builds on demand and verifies the archive checksum before extraction.
              </div>
              <Button
                onClick={async () => {
                  try {
                    await api.post("/api/java/install", { major: server.javaMajor });
                  } catch { /* handled by toast elsewhere */ }
                }}
                disabled={!can("java.manage")}
              >
                Pre-install Java {server.javaMajor}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}

export function DatabasesPage({ server }: { server: ServerSummary }) {
  return (
    <>
      <PageHeader title="Databases" icon={<Server size={19} />} subtitle={<>Database provisioning for <strong style={{ color: "var(--text)" }}>{server.name}</strong></>} />
      <Banner tone="warning" title="Not implemented in this build — reported honestly">
        RSLMC does not provision MySQL/MariaDB databases for plugins. Doing it properly requires managing a database server, per-database credentials and network grants, none of which exist in this build.
        The page is intentionally present instead of being hidden or faked.
      </Banner>
      <Card title="What plugins can use today" icon={<Server size={12} />}>
        <div className="stack" style={{ gap: 10, fontSize: 12.5, color: "var(--text-dim)", lineHeight: 1.65 }}>
          <p style={{ margin: 0 }}>
            Most plugins fall back to SQLite or YAML storage inside the server directory, which RSLMC backs up with the rest of the data. If a plugin requires an external database, configure its credentials in the plugin's own config file through the Files page.
          </p>
          <p style={{ margin: 0 }}>
            What a complete implementation would add: a managed MariaDB instance per node, per-server schemas, generated credentials stored with envelope encryption, connection limits and an audit trail for every credential view.
          </p>
          <div className="row" style={{ gap: 8 }}>
            <Pill tone="neutral">SQLite (plugin-managed)</Pill>
            <Pill tone="neutral">YAML (plugin-managed)</Pill>
            <Pill tone="amber">MySQL — not provisioned</Pill>
          </div>
        </div>
      </Card>
    </>
  );
}

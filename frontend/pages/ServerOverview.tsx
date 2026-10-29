import { useEffect, useMemo, useState } from "react";
import {
  Activity, AlertTriangle, ArrowRight, Cpu, HardDrive, Info, MemoryStick, Power, RotateCcw,
  Server, Skull, Square, Terminal, Users2, Gauge, ShieldCheck,
} from "lucide-react";
import type { ServerSummary, ServerStatus } from "../../src/shared/types";
import { Button, Card, CopyValue, InfoList, PageHeader, Pill, ProgressBar, StatCard, Banner, Loading, Modal } from "../components/ui";
import { ConsolePanel, mergeLines, type ConsoleLine } from "../components/console";
import { LineChart } from "../components/charts";
import { Link, useRouter } from "../lib/router";
import { useSession, useToast } from "../lib/app";
import { api, ApiError, errorMessage } from "../lib/api";
import { usePanelSocket } from "../lib/ws";
import { formatBytes, formatDuration, formatMegabytes, formatUptime, statusLabel, statusTone, cpuAllocationLabel } from "../lib/format";

interface ServerDetail {
  server: ServerSummary;
  runtime: {
    status: ServerStatus; pid: number | null; exitCode: number | null; lastError: string | null;
    ready: boolean; stopKind: string | null; enforcementMessage: string | null; cgroupAttached: boolean;
    /** True when the JVM was started outside the panel and merely adopted for reporting. */
    foreign?: boolean;
    uptimeSeconds: number;
  };
  java: { id: number; major: number; version: string; vendor: string; path: string } | null;
  javaCompatibility: { ok: boolean; note: string; required: number };
  metrics: { cpuPercent: number; cpuSource?: string; memBytes: number; memCacheBytes?: number; diskBytes: number; players: number; uptimeSeconds: number };
  enforcement: ServerSummary["enforcement"];
  installError: string | null;
}

/** One compact, honest line for the server info panel (details on hover). */
function limitSummary(enforcement: ServerDetail["enforcement"] | undefined): string {
  if (!enforcement) return "Unknown";
  const levels = [enforcement.memory?.level, enforcement.cpu?.level, enforcement.disk?.level];
  if (levels.every((level) => level === "enforced")) return "Enforced by the kernel";
  if (levels.some((level) => level === "enforced")) return "Partly enforced (hover)";
  return "Advisory — JVM heap only";
}

export function ServerOverviewPage({ serverId }: { serverId: number }) {
  const { can } = useSession();
  const toast = useToast();
  const { navigate } = useRouter();
  const [detail, setDetail] = useState<ServerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [metrics, setMetrics] = useState<{ cpu: number; mem: number; disk: number; players: number; uptime: number } | null>(null);
  const [history, setHistory] = useState<{ ts: number; cpu: number; mem: number; players: number }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [eulaPrompt, setEulaPrompt] = useState<{ action: "start" | "restart" } | null>(null);
  const [status, setStatus] = useState<ServerStatus>("offline");

  const load = async () => {
    try {
      const data = await api.get<ServerDetail>(`/api/servers/${serverId}`);
      setDetail(data);
      setStatus(data.server.status);
      setMetrics({
        cpu: data.metrics.cpuPercent, mem: data.metrics.memBytes, disk: data.metrics.diskBytes,
        players: data.metrics.players, uptime: data.metrics.uptimeSeconds,
      });
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [serverId]);

  useEffect(() => {
    api.get<{ data: { ts: number; cpu: number; mem: number; players: number }[] }>(`/api/servers/${serverId}/metrics?range=1h`)
      .then((result) => setHistory(result.data))
      .catch(() => setHistory([]));
  }, [serverId]);

  useEffect(() => {
    api.get<{ data: ConsoleLine[] }>(`/api/servers/${serverId}/console?limit=120`)
      .then((result) => setLines(result.data))
      .catch(() => {});
  }, [serverId]);

  const socketState = usePanelSocket(serverId, (message) => {
    if (message.type === "console") {
      setLines((current) => [...current, ...message.lines].slice(-400));
    } else if (message.type === "console.history") {
      setLines(message.lines.slice(-400));
    } else if (message.type === "status") {
      setStatus(message.status as ServerStatus);
      if (message.status === "online" || message.status === "offline") void load();
    } else if (message.type === "metrics") {
      const incoming = message.metrics;
      setMetrics({
        cpu: incoming.cpuPercent, mem: incoming.memBytes,
        disk: incoming.diskBytes || (detail?.metrics.diskBytes ?? 0),
        players: incoming.players, uptime: incoming.uptimeSeconds,
      });
      setHistory((current) => [...current, { ts: incoming.ts, cpu: incoming.cpuPercent, mem: incoming.memBytes, players: incoming.players }].slice(-120));
    } else if (message.type === "progress" && message.kind === "install") {
      if (message.done && message.error) {
        toast.error("Installation failed", message.error);
        void load();
      } else if (message.done) {
        toast.success("Installation finished", message.label);
        void load();
      }
    }
  });

  // Same fallback as the full console page: keep the recent-output card live without a socket.
  useEffect(() => {
    if (socketState === "open") return;
    const timer = setInterval(() => {
      api.get<{ data: ConsoleLine[] }>(`/api/servers/${serverId}/console?limit=120`)
        .then((result) => setLines((current) => mergeLines(current, result.data, 400)))
        .catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [socketState, serverId]);


  const power = async (action: "start" | "stop" | "restart" | "kill") => {
    setBusy(action);
    try {
      await api.post(`/api/servers/${serverId}/power`, { action });
      toast.success(
        action === "start" ? "Start requested" : action === "stop" ? "Graceful stop requested" : action === "restart" ? "Restart requested" : "Force kill requested",
        action === "stop" ? "The stop button becomes Kill while shutdown is pending." : undefined,
      );
      setStatus(action === "start" ? "starting" : action === "stop" ? "stopping" : action === "kill" ? "stopping" : "restarting");
    } catch (err) {
      if (err instanceof ApiError && err.code === "eula_required" && action !== "stop" && action !== "kill") {
        setEulaPrompt({ action: action === "restart" ? "restart" : "start" });
      } else if (err instanceof ApiError && err.code === "not_installed") {
        toast.error("Server is not installed", "Open the installation banner above and retry the installation first.");
      } else {
        toast.fromError(err, "Power action failed");
      }
    } finally {
      setBusy(null);
    }
  };

  const acceptEulaAndRun = async () => {
    const pending = eulaPrompt?.action ?? "start";
    setBusy("eula");
    try {
      await api.post(`/api/servers/${serverId}/eula`, { accept: true });
      setEulaPrompt(null);
      toast.success("EULA accepted", "Recorded for this server; eula.txt has been written.");
      await api.post(`/api/servers/${serverId}/power`, { action: pending });
      setStatus(pending === "restart" ? "restarting" : "starting");
    } catch (err) {
      toast.fromError(err, "Could not accept the EULA");
    } finally {
      setBusy(null);
    }
  };

  const reinstall = async () => {
    setBusy("reinstall");
    try {
      await api.post(`/api/servers/${serverId}/reinstall`, { preserveData: true });
      toast.success("Reinstallation started", "Java and the server software are being downloaded again.");
      await load();
    } catch (err) {
      toast.fromError(err, "Could not start the reinstallation");
    } finally {
      setBusy(null);
    }
  };

  const server = detail?.server;
  // installed_at is only set once Java + the server software are actually in place.
  const installIncomplete = Boolean(server) && !server!.installedAt && status !== "installing";
  const foreign = detail?.runtime.foreign === true;
  const running = status === "online" || status === "starting";
  const stopping = status === "stopping" || status === "restarting";

  if (loading) return <Loading label="Loading server overview…" minHeight={320} />;
  if (error || !server) {
    return (
      <Banner tone="error" title="Could not load this server">
        {error ?? "The server could not be found."}{" "}
        <Button size="sm" onClick={() => void load()} style={{ marginLeft: 8 }}>Retry</Button>
      </Banner>
    );
  }

  const memoryUsed = metrics?.mem ?? 0;
  const memoryAllocated = server.memoryMb * 1024 * 1024;
  const diskUsed = metrics?.disk ?? detail.metrics.diskBytes;
  const diskAllocated = server.diskMb * 1024 * 1024;
  const uptime = formatUptime(metrics?.uptime ?? server.uptimeSeconds);
  const cpuPercent = metrics?.cpu ?? 0;
  const cpuRelativeToAllocation = server.cpuPercent > 0 ? (cpuPercent / server.cpuPercent) * 100 : 0;

  return (
    <>
      <PageHeader
        title={server.name}
        icon={<Server size={19} />}
        status={<Pill tone={statusTone(status)} dot>{statusLabel(status)}</Pill>}
        subtitle={
          <>
            <span>{server.software.charAt(0).toUpperCase() + server.software.slice(1)} {server.mcVersion}</span>
            <span className="faint">·</span>
            <CopyValue value={server.playAddress ?? server.address} title={server.publicHost ? `Players join with ${server.playAddress}` : `Copy the server address (internal: ${server.internalAddress ?? server.address})`} />
            <span className="faint">·</span>
            <span>{server.nodeName}</span>
            {detail?.runtime.stopKind === "forced" ? (
              <Pill tone="amber" dot>Last stop: forced</Pill>
            ) : null}
          </>
        }
        actions={
          <>
            <Button
              icon={<RotateCcw size={14} />}
              onClick={() => void power("restart")}
              disabled={!running || stopping || busy !== null || !can("server.restart")}
              loading={busy === "restart"}
            >
              Restart
            </Button>
            {stopping ? (
              <Button
                variant="danger"
                icon={<Skull size={14} />}
                onClick={() => void power("kill")}
                loading={busy === "kill"}
                disabled={!can("server.kill")}
                title="Terminate the process tree immediately"
              >
                Kill
              </Button>
            ) : running ? (
              <Button
                variant="warn"
                icon={<Square size={13} />}
                onClick={() => void power("stop")}
                loading={busy === "stop"}
                disabled={!can("server.stop")}
                title="Send the graceful stop command to the server console"
              >
                Stop
              </Button>
            ) : (
              <Button
                variant="success"
                icon={<Power size={14} />}
                onClick={() => void power("start")}
                loading={busy === "start"}
                disabled={!can("server.start") || status === "installing" || installIncomplete}
              title={installIncomplete ? "Installation has not finished — retry it from the banner above" : undefined}
              >
                Start
              </Button>
            )}
            <Button
              variant="danger"
              className="btn-icon"
              aria-label="Force kill"
              title="Force kill"
              onClick={() => void power("kill")}
              disabled={!running && !stopping || !can("server.kill")}
              icon={<Skull size={14} />}
            />
          </>
        }
      />

      {foreign ? (
        <Banner tone="warning" title="A Java process outside RSLMC is running this server">
          This server's directory is in use by Java process
          {detail?.runtime.pid ? <span className="mono"> (pid {detail.runtime.pid})</span> : null}
          {" "}that RSLMC did not start — it survived a panel restart or was launched from a shell, so its
          console output cannot be captured here. Force-kill it, then press Start to hand control back to the panel.
          <div className="row" style={{ marginTop: 8, gap: 8 }}>
            <Button size="sm" variant="danger" loading={busy === "kill"} onClick={() => void power("kill")}>Force kill</Button>
            <Button size="sm" onClick={() => navigate(`/servers/${serverId}/console`)}>Open console</Button>
          </div>
        </Banner>
      ) : status === "error" && !running ? (
        <Banner tone="error" title="Installation failed">
          <span className="mono" style={{ fontSize: 11.5 }}>
            {detail?.installError ?? "The last installation did not finish. Retry it to download Java and the server software again."}
          </span>
          <div className="row" style={{ marginTop: 8, gap: 8 }}>
            <Button size="sm" variant="primary" loading={busy === "reinstall"} onClick={() => void reinstall()}>Retry installation</Button>
            <Button size="sm" onClick={() => navigate(`/servers/${serverId}/console`)}>Open console</Button>
          </div>
        </Banner>
      ) : status === "crashed" ? (
        <Banner tone="error" title="The server process is not running">
          {detail?.runtime.lastError ? `${detail.runtime.lastError}. ` : "The last start attempt failed. "}
          Check the console for the underlying cause.
          <Button size="sm" style={{ marginLeft: 8 }} onClick={() => navigate(`/servers/${serverId}/console`)}>Open console</Button>
        </Banner>
      ) : null}

      {installIncomplete && status !== "error" && !foreign && !running ? (
        <Banner tone="warning" title="Installation has not finished">
          Java or the server software is missing from this server's directory, so it cannot start yet.
          <div className="row" style={{ marginTop: 8, gap: 8 }}>
            <Button size="sm" variant="primary" loading={busy === "reinstall"} onClick={() => void reinstall()}>Retry installation</Button>
          </div>
        </Banner>
      ) : null}

      {status === "installing" ? (
        <Banner tone="info" title="Installation in progress">
          RSLMC is downloading the Java runtime and server software. Progress is streamed below; this page updates when it completes.
        </Banner>
      ) : null}

      <div className="stat-grid">
        <StatCard
          label="CPU" icon={<Cpu size={12} />} accent="var(--blue)"
          value={detail.metrics.cpuSource === "unavailable" ? "—" : (cpuPercent ?? 0).toFixed(1)} unit="%"
          meta={
            detail.metrics.cpuSource === "unavailable"
              ? <span title="RSLMC could not read CPU time for this process on this host.">Sampler unavailable</span>
              : <span>{cpuAllocationLabel(server.cpuPercent)}</span>
          }
          progress={cpuRelativeToAllocation}
          hintTitle={detail.enforcement?.cpu.level === "enforced" ? "CPU: kernel quota enforced" : "CPU: advisory allocation — this host cannot hard-cap CPU for the server"}
        />
        <StatCard
          label="Memory" icon={<MemoryStick size={12} />} accent="var(--green)"
          value={formatMegabytes(memoryUsed)} unit="MB"
          meta={<span>{formatMegabytes(memoryUsed)} / {server.memoryMb} MB</span>}
          progress={memoryAllocated > 0 ? (memoryUsed / memoryAllocated) * 100 : 0}
          hintTitle={detail.enforcement?.memory.level === "enforced"
            ? `Memory: capped at ${server.memoryMb} MB by the kernel (cgroup memory.max). Cached files are not counted.`
            : `Memory: only the Java heap is limited; native memory can go above ${server.memoryMb} MB. Cached files are not counted.`}
        />
        <StatCard
          label="Players" icon={<Users2 size={12} />} accent="var(--green)"
          value={metrics?.players ?? server.playersOnline} unit={`/ ${server.maxPlayers}`}
          meta={<span>{metrics?.players ? "Online now" : "Nobody online"}</span>}
          progress={server.maxPlayers > 0 ? ((metrics?.players ?? 0) / server.maxPlayers) * 100 : 0}
        />
        <StatCard
          label="Disk" icon={<HardDrive size={12} />} accent="var(--amber)"
          value={diskAllocated > 0 ? ((diskUsed / diskAllocated) * 100).toFixed(1) : "0"} unit="%"
          meta={<span>{formatBytes(diskUsed)} / {formatBytes(diskAllocated)}</span>}
          progress={diskAllocated > 0 ? (diskUsed / diskAllocated) * 100 : 0}
          hintTitle={detail.enforcement?.disk.level === "enforced" ? "Disk: quota enforced" : "Disk: usage tracked — no hard quota"}
        />
        <StatCard
          label="Uptime" icon={<Gauge size={12} />} accent="var(--blue)"
          value={uptime.value} unit={uptime.unit}
          meta={<span>{running ? "Since last start" : "Offline"}</span>}
        />
      </div>

      <div className="overview-main">
        <Card
          title="Recent console"
          icon={<Terminal size={12} />}
          bodyClass="tight"
          actions={
            <Link to={`/servers/${serverId}/console`} className="btn btn-sm">
              Open full <ArrowRight size={12} />
            </Link>
          }
        >
          <ConsolePanel
            serverId={serverId}
            lines={lines.slice(-160)}
            live={running || foreign}
            connection={socketState}
            foreign={foreign}
            height={380}
            canCommand={can("server.command")}
            compact
          />
        </Card>

        <div className="stack">
          <Card title="Server info" icon={<Info size={12} />} bodyClass="tight">
            <InfoList
              rows={[
                { key: "Status", value: <Pill tone={statusTone(status)} dot>{statusLabel(status)}</Pill> },
                {
                  key: "Address",
                  value: <CopyValue value={server.playAddress ?? server.address} title={server.publicHost ? `Players join with ${server.playAddress}` : "Copy the server address"} />,
                },
                ...(server.publicHost
                  ? [{ key: "Internal", value: <span className="mono faint text-xs">{server.internalAddress ?? `${server.bindIp}:${server.port}`}</span> }]
                  : []),
                { key: "Software", value: server.software.charAt(0).toUpperCase() + server.software.slice(1) },
                { key: "Version", value: server.mcVersion },
                { key: "Java", value: detail.java ? `${detail.java.vendor ?? "Temurin"} ${detail.java.major} (${detail.java.version})` : `Java ${server.javaMajor} (installed on start)` },
                { key: "Allocated RAM", value: `${server.memoryMb} MB` },
                { key: "CPU allocation", value: cpuAllocationLabel(server.cpuPercent) },
                { key: "Disk", value: formatBytes(diskAllocated) },
                {
                  key: "Resource limits",
                  value: (
                    <span style={{ cursor: "help" }} title={detail.enforcement?.memory.note ?? undefined}>
                      {limitSummary(detail.enforcement)}
                    </span>
                  ),
                },
                { key: "Node", value: server.nodeName ?? "—" },
                { key: "Owner", value: server.ownerName ?? "—" },
                { key: "Created", value: new Date(server.createdAt).toLocaleDateString() },
              ]}
            />
          </Card>

        </div>
      </div>

      <Card
        title="Performance metrics"
        icon={<Activity size={12} />}
        actions={<span className="row faint text-xs" style={{ gap: 6 }}><span className="live-dot" /> Live · sampling every 1s</span>}
      >
        <div className="grid grid-3" style={{ gap: 16 }}>
          <div>
            <div className="row" style={{ marginBottom: 4 }}>
              <span className="card-title"><Cpu size={11} /> CPU</span>
              <span className="spacer" />
              <span className="mono text-xs" style={{ color: "var(--blue)" }}>{cpuPercent.toFixed(1)}%</span>
            </div>
            <LineChart
              height={120}
              times
              series={[{ label: "CPU %", color: "#3f8cff", points: history.map((point) => ({ ts: point.ts, value: point.cpu })) }]}
            />
          </div>
          <div>
            <div className="row" style={{ marginBottom: 4 }}>
              <span className="card-title"><MemoryStick size={11} /> Memory</span>
              <span className="spacer" />
              <span className="mono text-xs" style={{ color: "var(--green)" }}>
                {memoryAllocated > 0 ? ((memoryUsed / memoryAllocated) * 100).toFixed(1) : "0"}%
              </span>
            </div>
            <LineChart
              height={120}
              times
              unit=" MB"
              series={[{
                label: "Memory (MB)", color: "#3ecf72",
                points: history.map((point) => ({ ts: point.ts, value: point.mem / 1024 / 1024 })),
              }]}
            />
          </div>
          <div>
            <div className="row" style={{ marginBottom: 4 }}>
              <span className="card-title"><Users2 size={11} /> Players</span>
              <span className="spacer" />
              <span className="mono text-xs">{metrics?.players ?? 0}</span>
            </div>
            <LineChart
              height={120}
              times
              unit=""
              max={Math.max(server.maxPlayers, 5)}
              series={[{ label: "Online players", color: "#a78bfa", points: history.map((point) => ({ ts: point.ts, value: point.players })) }]}
            />
          </div>
        </div>
        <div className="row" style={{ marginTop: 12, gap: 14, flexWrap: "wrap" }}>
          <span className="text-xs faint">Disk {formatBytes(diskUsed)} of {formatBytes(diskAllocated)}</span>
          <div style={{ flex: 1, minWidth: 120 }}><ProgressBar value={diskAllocated > 0 ? (diskUsed / diskAllocated) * 100 : 0} tone="var(--amber)" /></div>
          <span className="text-xs faint">Uptime {formatDuration(metrics?.uptime ?? 0)}</span>
          {detail.runtime.cgroupAttached ? <Pill tone="green">cgroup attached</Pill> : null}
          {detail.runtime.pid ? <span className="text-xs faint mono">PID {detail.runtime.pid}</span> : null}
          {!detail.javaCompatibility.ok ? (
            <span className="row text-xs" style={{ color: "#e8c46a", gap: 5 }}>
              <AlertTriangle size={11} /> {detail.javaCompatibility.note}
            </span>
          ) : null}
        </div>
      </Card>

      <Modal
        open={eulaPrompt !== null}
        onClose={() => setEulaPrompt(null)}
        title="Minecraft EULA"
        icon={<ShieldCheck size={14} />}
        size="narrow"
        footer={
          <>
            <Button onClick={() => setEulaPrompt(null)}>Cancel</Button>
            <Button variant="primary" loading={busy === "eula"} onClick={() => void acceptEulaAndRun()}>
              I accept — {eulaPrompt?.action === "restart" ? "restart" : "start"} the server
            </Button>
          </>
        }
      >
        <p className="text-sm muted" style={{ lineHeight: 1.6 }}>
          RSLMC needs your acceptance of the Minecraft End User Licence Agreement for{" "}
          <strong style={{ color: "var(--text)" }}>{server.name}</strong> before it can run the server jar.
          Accepting writes <span className="mono">eula=true</span> to <span className="mono">eula.txt</span> in the
          server directory and records the decision against this server.
        </p>
        <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer" className="text-sm" style={{ color: "var(--blue)" }}>
          Read the Minecraft EULA
        </a>
      </Modal>
    </>
  );
}

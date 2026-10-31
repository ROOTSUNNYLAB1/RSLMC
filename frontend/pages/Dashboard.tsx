import { useEffect, useRef, useState } from "react";
import {
  Activity, Cpu, HardDrive, MemoryStick, Plus, Server, ServerCog, Users2, ArrowRight, Globe2,
  ShieldCheck, CheckCircle2, AlertTriangle, Clock,
} from "lucide-react";
import type { ServerSummary } from "../../src/shared/types";
import { Button, Card, CopyValue, EmptyState, Loading, PageHeader, Pill, StatCard, Banner, InfoList } from "../components/ui";
import { Link, useRouter } from "../lib/router";
import { useSession } from "../lib/app";
import { api, errorMessage } from "../lib/api";
import { formatBytes, formatDuration, relativeTime, statusLabel, statusTone } from "../lib/format";

interface AdminOverview {
  panel: { version: string; mode: string; uptimeSeconds: number; bunVersion: string; dataDir: string | null };
  counts: {
    servers: number; onlineServers: number; offlineServers: number; users: number; nodes: number;
    onlineNodes: number; playersOnline: number; backups: number; failedOps: number; javaRuntimes: number;
  };
  resources: {
    allocatedMemoryMb: number; allocatedCpuPercent: number;
    disk: { totalBytes: number; usedBytes: number; freeBytes: number };
    host: { cpuCores: number; cpuUsagePercent: number; memoryTotalBytes: number; memoryUsedBytes: number; loadAverage: number[] };
  };
  servers: ServerSummary[];
  nodes: { id: number; name: string; isLocal: boolean; online: boolean; maintenance: boolean; lastHeartbeatAt: string | null }[];
  recentEvents: { id: number; ts: string; type: string; actorName: string | null; serverName: string | null; result: string; target: string | null }[];
  enforcement: { memory: { level: string; mechanism: string } };
  security: { mustChangePasswordUsers: number; totpEnabled: number; weakMode: boolean };
}

export function DashboardPage() {
  const { user, can } = useSession();
  const { navigate } = useRouter();
  const [servers, setServers] = useState<ServerSummary[] | null>(null);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sampledAt, setSampledAt] = useState<number | null>(null);

  // Read live usage every second. Refs keep the interval stable so it is never torn down and
  // rebuilt on re-render (which would also reset the tick).
  const canViewAdmin = can(["node.view", "user.view"]);
  const canViewAdminRef = useRef(canViewAdmin);
  canViewAdminRef.current = canViewAdmin;
  const hasDataRef = useRef(false);

  useEffect(() => {
    let alive = true;
    let busy = false;

    const tick = async () => {
      // A hidden tab does not need 1s sampling.
      if (!alive || busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        const result = await api.get<{ data: ServerSummary[] }>("/api/servers");
        if (!alive) return;
        setServers(result.data);
        hasDataRef.current = true;
        setSampledAt(Date.now());
        setError(null);
        if (canViewAdminRef.current) {
          const admin = await api.get<AdminOverview>("/api/admin/overview");
          if (alive) setOverview(admin);
        }
      } catch (err) {
        // Keep showing the last good numbers if a single poll fails.
        if (alive && !hasDataRef.current) setError(errorMessage(err));
      } finally {
        busy = false;
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), 1000);
    const onVisible = () => { if (document.visibilityState === "visible") void tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (error) return <Banner tone="error" title="Could not load your servers">{error}</Banner>;
  if (!servers) return <Loading label="Loading dashboard…" minHeight={280} />;

  const online = servers.filter((server) => ["online", "starting"].includes(server.status)).length;
  const totalPlayers = servers.reduce((sum, server) => sum + server.playersOnline, 0);
  const totalMemory = servers.reduce((sum, server) => sum + server.memoryMb, 0);
  const host = overview?.resources.host;

  return (
    <>
      <PageHeader
        title="Dashboard"
        icon={<Activity size={19} />}
        subtitle={
          <>
            Welcome back, <strong style={{ color: "var(--text)" }}>{user?.username}</strong> · {servers.length} {servers.length === 1 ? "server" : "servers"} available
            <Pill tone="green" dot>live · 1s</Pill>
            {sampledAt ? <span className="text-xs faint">updated {new Date(sampledAt).toLocaleTimeString()}</span> : null}
          </>
        }
        actions={can("server.create") ? (
          <Button variant="primary" icon={<Plus size={14} />} onClick={() => navigate("/servers/new")}>New server</Button>
        ) : undefined}
      />

      <div className="stat-grid">
        <StatCard label="Servers" icon={<Server size={11} />} accent="var(--green)" value={servers.length} meta={<span>{online} running</span>} />
        <StatCard label="Players online" icon={<Users2 size={11} />} accent="var(--blue)" value={totalPlayers} meta={<span>across all servers</span>} />
        <StatCard label="Allocated memory" icon={<MemoryStick size={11} />} accent="var(--amber)" value={totalMemory >= 1024 ? (totalMemory / 1024).toFixed(1) : totalMemory} unit={totalMemory >= 1024 ? "GB" : "MB"} meta={<span>{servers.length} allocations</span>} />
        <StatCard label="Host CPU" icon={<Cpu size={11} />} accent="var(--blue)" value={host ? host.cpuUsagePercent.toFixed(1) : "—"} unit="%" meta={<span>{host ? `${host.cpuCores} cores · load ${host.loadAverage[0].toFixed(2)}` : "unavailable"}</span>} progress={host?.cpuUsagePercent} />
        <StatCard label="Disk" icon={<HardDrive size={11} />} accent="var(--amber)" value={overview ? formatBytes(overview.resources.disk.usedBytes) : "—"} meta={<span>{overview ? `${formatBytes(overview.resources.disk.freeBytes)} free` : "unavailable"}</span>} progress={overview ? (overview.resources.disk.usedBytes / Math.max(1, overview.resources.disk.totalBytes)) * 100 : undefined} />
      </div>

      {servers.length === 0 ? (
        <Card title="Your servers" icon={<Server size={12} />}>
          <EmptyState
            icon={<ServerCog size={18} />}
            title="No servers yet"
            description="Create your first Minecraft server. RSLMC downloads the matching Java runtime and server software automatically — nothing has to be installed on the host."
            action={can("server.create") ? <Button variant="primary" icon={<Plus size={14} />} onClick={() => navigate("/servers/new")}>Create a server</Button> : undefined}
          />
        </Card>
      ) : (
        <div className="grid grid-3" style={{ marginBottom: 14 }}>
          {servers.map((server) => {
            const memoryUsedMb = server.usage?.memBytes ? Math.round(server.usage.memBytes / 1048576) : 0;
            // A live process is not only "online": a starting or adopted (recovering) server has real
            // usage too, and hiding it made the card look empty.
            const running = ["online", "starting", "stopping", "recovering"].includes(server.status);
            const cpuObserved = running && server.usage?.cpuPercent != null
              ? Number(server.usage.cpuPercent.toFixed(1)) : null;
            return (
            <Link key={server.id} to={`/servers/${server.id}/overview`} className="card" style={{ display: "block" }}>
              <div className="card-header">
                <div className="card-title" style={{ letterSpacing: 0 }}><Server size={12} />{server.name}</div>
                <div className="spacer" />
                <Pill tone={statusTone(server.status)} dot>{statusLabel(server.status)}</Pill>
              </div>
              <div className="card-body">
                <div className="row" style={{ marginBottom: 10 }}>
                  <CopyValue value={server.playAddress ?? server.address} mono={false} className="text-xs faint" title={server.publicHost ? `Players join with ${server.playAddress}` : "Copy the server address"} />
                  <span className="spacer" />
                  <span className="text-xs faint">{server.software} {server.mcVersion}</span>
                </div>
                <div className="server-metrics">
                  {/* A stopped server has no observed usage, so only its allocation is shown. */}
                  <span title={cpuObserved != null
                    ? `Observed CPU over the last sampling window · ${server.cpuPercent}% allocated`
                    : `CPU allocation · ${server.cpuPercent}% (100% = one core)`}>
                    <Cpu size={11} />
                    {cpuObserved != null ? <>{cpuObserved}% <span className="alloc">/ {server.cpuPercent}%</span></> : <span className="alloc">{server.cpuPercent}%</span>}
                  </span>
                  <span title={running ? `${memoryUsedMb} MB resident of ${server.memoryMb} MB allocated` : `${server.memoryMb} MB allocated`}>
                    <MemoryStick size={11} />
                    {running
                      ? <>{memoryUsedMb} <span className="alloc">/ {server.memoryMb} MB</span></>
                      : <span className="alloc">{server.memoryMb} MB</span>}
                  </span>
                  <span><Users2 size={11} /> {server.playersOnline}/{server.maxPlayers}</span>
                  <span className="spacer" />
                  <ArrowRight size={13} className="faint" />
                </div>
              </div>
            </Link>
            );
          })}
        </div>
      )}

      <div className="grid grid-2">
        <Card title="Recent activity" icon={<Activity size={12} />} bodyClass="tight">
          {overview?.recentEvents?.length ? (
            <div className="info-list">
              {overview.recentEvents.slice(0, 8).map((event) => (
                <div className="info-row" key={event.id}>
                  <span className={`pill ${event.result === "failure" ? "pill-red" : "pill-neutral"}`} style={{ textTransform: "none", letterSpacing: 0 }}>
                    {event.type.replace(/[._]/g, " ")}
                  </span>
                  <span className="text-xs faint truncate" style={{ maxWidth: 200 }}>{event.serverName ?? event.target ?? "panel"}</span>
                  <span className="v text-xs faint">{relativeTime(event.ts)}</span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState icon={<Clock size={16} />} title="No activity yet" description="Server lifecycle, player and security events appear here as they happen." />
          )}
        </Card>

        <Card title="Panel health" icon={<ShieldCheck size={12} />} bodyClass="tight">
          <InfoList
            rows={[
              {
                key: "Build",
                value: (
                  <span className="mono text-xs" title={overview?.panel ? `Bun ${overview.panel.bunVersion} · ${overview.panel.mode} mode` : undefined}>
                    {overview?.panel?.version ? `RSLMC ${overview.panel.version}` : <span className="faint">reading…</span>}
                  </span>
                ),
              },
              {
                key: "Resource enforcement",
                value: <Pill tone={overview?.enforcement.memory.level === "enforced" ? "green" : "amber"}>
                  {overview?.enforcement.memory.level === "enforced" ? "cgroup v2" : "advisory"}
                </Pill>,
              },
              { key: "Nodes online", value: `${overview?.counts.onlineNodes ?? "—"} / ${overview?.counts.nodes ?? "—"}` },
              { key: "Java runtimes", value: overview?.counts.javaRuntimes ?? "—" },
              { key: "Users", value: overview?.counts.users ?? "—" },
              { key: "Backups", value: overview?.counts.backups ?? "—" },
              {
                key: "Security",
                value: overview?.security.weakMode
                  ? <Pill tone="amber">development mode</Pill>
                  : <Pill tone="green">production</Pill>,
              },
              {
                key: "2FA adoption",
                value: <Pill tone={overview?.security.totpEnabled ? "green" : "neutral"}>
                  {overview?.security.totpEnabled ?? 0} of {overview?.counts.users ?? 0}
                </Pill>,
              },
            ]}
          />
          {overview && overview.counts.failedOps > 0 ? (
            <div style={{ padding: "10px 14px", borderTop: "1px solid var(--border)" }}>
              <span className="row text-xs" style={{ gap: 6, color: "#e8c46a" }}>
                <AlertTriangle size={12} /> {overview.counts.failedOps} failed operation(s) in the last 24 hours
              </span>
            </div>
          ) : (
            <div style={{ padding: "10px 14px", borderTop: "1px solid var(--border)" }}>
              <span className="row text-xs faint" style={{ gap: 6 }}>
                <CheckCircle2 size={12} color="var(--green)" /> No failed operations in the last 24 hours
              </span>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

export function ServersPage() {
  const { can } = useSession();
  const { navigate } = useRouter();
  const [servers, setServers] = useState<ServerSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const hasDataRef = useRef(false);

  // Same one-second live refresh as the dashboard: the CPU/Memory columns are live numbers.
  useEffect(() => {
    let alive = true;
    let busy = false;
    const tick = async () => {
      if (!alive || busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        const result = await api.get<{ data: ServerSummary[] }>("/api/servers");
        if (!alive) return;
        setServers(result.data);
        hasDataRef.current = true;
        setUpdatedAt(Date.now());
        setError(null);
      } catch (err) {
        if (alive && !hasDataRef.current) setError(errorMessage(err));
      } finally {
        busy = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 1000);
    const onVisible = () => { if (document.visibilityState === "visible") void tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (error) return <Banner tone="error" title="Could not load servers">{error}</Banner>;

  return (
    <>
      <PageHeader
        title="Servers"
        icon={<ServerCog size={19} />}
        subtitle={
          <>
            Every Minecraft server managed by this panel.
            <Pill tone="green" dot>live · 1s</Pill>
            {updatedAt ? <span className="text-xs faint">updated {new Date(updatedAt).toLocaleTimeString()}</span> : null}
          </>
        }
        actions={can("server.create") ? <Button variant="primary" icon={<Plus size={14} />} onClick={() => navigate("/servers/new")}>New server</Button> : undefined}
      />
      <Card bodyClass="tight">
        {!servers ? <Loading label="Loading servers…" /> : servers.length === 0 ? (
          <EmptyState
            icon={<ServerCog size={17} />}
            title="No servers"
            description={can("server.create")
              ? "Create a server to get started."
              : "No servers have been allocated to your account yet. An administrator can give you access from Administration → Users → Servers."}
            action={can("server.create") ? <Button onClick={() => navigate("/servers/new")}>Create server</Button> : undefined}
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Server</th><th>Status</th><th>Software</th><th>Address</th><th>Players</th><th>Memory</th><th>CPU usage</th><th>Uptime</th><th />
              </tr>
            </thead>
            <tbody>
              {servers.map((server) => (
                <tr key={server.id}>
                  <td><strong>{server.name}</strong><div className="text-xs faint">{server.nodeName}</div></td>
                  <td><Pill tone={statusTone(server.status)} dot>{statusLabel(server.status)}</Pill></td>
                  <td className="text-xs">{server.software} {server.mcVersion}<div className="faint">Java {server.javaMajor}</div></td>
                  <td className="text-xs"><CopyValue value={server.playAddress ?? server.address} title={server.publicHost ? `Players join with ${server.playAddress}` : "Copy the server address"} /></td>
                  <td>{server.playersOnline}/{server.maxPlayers}</td>
                  <td>
                    {server.usage ? (
                      <span title={`${server.usage.memBytes ? Math.round(server.usage.memBytes / 1048576) : 0} MB of ${server.memoryMb} MB allocated`}>
                        {server.usage.memBytes ? Math.round(server.usage.memBytes / 1048576) : 0}
                        <span className="faint"> / {server.memoryMb} MB</span>
                      </span>
                    ) : (
                      <span className="faint">{server.memoryMb} MB<span title="Allocation"> alloc</span></span>
                    )}
                  </td>
                  <td>
                    {server.usage ? (
                      server.usage.cpuPercent === null ? (
                        <span className="faint" title={`Sampler unavailable (${server.usage.cpuSource})`}>—</span>
                      ) : (
                        <span title={`Observed over the last sampling window · ${server.cpuPercent}% allocated`}>
                          {server.usage.cpuPercent.toFixed(1)}%
                          <span className="faint"> / {server.cpuPercent}%</span>
                        </span>
                      )
                    ) : (
                      <span className="faint">—</span>
                    )}
                  </td>
                  <td className="text-xs">{server.uptimeSeconds ? formatDuration(server.uptimeSeconds) : "—"}</td>
                  <td className="actions">
                    <Button size="sm" onClick={() => navigate(`/servers/${server.id}/overview`)}>Open</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

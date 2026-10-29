import { useEffect, useState } from "react";
import { Globe2, Link2, Network, Plus, RefreshCw, Save, ShieldAlert, Wifi } from "lucide-react";
import type { ServerSummary } from "../../src/shared/types";
import { Banner, Button, Card, CopyValue, Field, Input, Loading, PageHeader, Pill, StatCard, Toggle } from "../components/ui";
import { api } from "../lib/api";
import { useSession, useToast } from "../lib/app";

interface Allocation { id: number; ip: string; port: number; ip_alias: string | null; notes: string | null; is_primary?: number }

export function NetworkingPage({ server }: { server: ServerSummary }) {
  const { can } = useSession();
  const toast = useToast();
  const [data, setData] = useState<any>(null);
  const [allocations, setAllocations] = useState<Allocation[]>([]);
  const [newIp, setNewIp] = useState("0.0.0.0");
  const [newPort, setNewPort] = useState(server.port + 1);
  const [busy, setBusy] = useState(false);
  // Optional public address (playit.gg, ngrok, FRP…) — what players actually type.
  const [publicHost, setPublicHost] = useState("");
  const [publicPort, setPublicPort] = useState("");
  const [savingPublic, setSavingPublic] = useState(false);

  const load = async () => {
    try {
      const result = await api.get<any>(`/api/servers/${server.id}/allocations`);
      setAllocations(result.data);
      const settings = await api.get<any>(`/api/servers/${server.id}/settings`);
      setData(settings);
      setPublicHost(settings.raw?.publicHost ?? "");
      setPublicPort(settings.raw?.publicPort ? String(settings.raw.publicPort) : "");
    } catch (err) {
      toast.fromError(err, "Could not load networking");
    }
  };

  useEffect(() => { void load(); }, [server.id]);

  const addAllocation = async () => {
    setBusy(true);
    try {
      await api.post(`/api/servers/${server.id}/allocations`, { ip: newIp, port: Number(newPort) });
      toast.success("Allocation created", `${newIp}:${newPort}`);
      await load();
    } catch (err) {
      toast.fromError(err, "Could not create allocation");
    } finally {
      setBusy(false);
    }
  };

  const savePublicAddress = async () => {
    setSavingPublic(true);
    try {
      await api.patch(`/api/servers/${server.id}`, {
        publicHost: publicHost.trim() ? publicHost.trim() : null,
        publicPort: publicPort.trim() ? Number(publicPort) : null,
      });
      toast.success(
        publicHost.trim() ? "Public address saved" : "Public address cleared",
        publicHost.trim() ? "Shown and copied wherever the server address appears." : "Players see the internal address again.",
      );
      await load();
    } catch (err) {
      toast.fromError(err, "Could not save the public address");
    } finally {
      setSavingPublic(false);
    }
  };

  if (!data) return <Loading label="Loading networking…" minHeight={240} />;

  const wildcard = server.bindIp === "0.0.0.0" || server.bindIp === "::";

  return (
    <>
      <PageHeader
        title="Networking"
        icon={<Network size={19} />}
        subtitle={<>Address bindings for <strong style={{ color: "var(--text)" }}>{server.name}</strong></>}
        actions={<Button icon={<RefreshCw size={14} />} onClick={() => void load()}>Refresh</Button>}
      />

      <div className="stat-grid" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        <StatCard
          label={server.publicHost ? "Players join with" : "Primary allocation"}
          icon={<Globe2 size={11} />} accent="var(--green)"
          value={<span className="mono" style={{ fontSize: 16 }}>{(server.playAddress ?? server.address).replace(/:\d+$/, "")}</span>}
          meta={<span>{server.publicHost ? `public address · internal ${server.internalAddress ?? `${server.bindIp}:${server.port}`}` : `bound to ${server.bindIp}`}</span>}
        />
        <StatCard label="Allocations" icon={<Network size={11} />} accent="var(--blue)" value={allocations.length} meta={<span>on node {server.nodeName}</span>} />
        <StatCard
          label="Binding scope" icon={<Wifi size={11} />} accent={wildcard ? "var(--amber)" : "var(--green)"}
          value={wildcard ? "Public" : "Local"} meta={<span>{wildcard ? "listening on all interfaces" : "restricted to a single interface"}</span>}
        />
      </div>

      <div className="grid grid-2">
        <Card title="Primary endpoint" icon={<Globe2 size={12} />} bodyClass="tight">
          <div className="info-list">
            <div className="info-row"><span className="k">Bind address</span><span className="v mono">{server.bindIp}</span></div>
            <div className="info-row"><span className="k">Internal address</span><span className="v mono">{data.raw.internalAddress ?? `${server.bindIp}:${server.port}`}</span></div>
            <div className="info-row">
              <span className="k">Players join with</span>
              <span className="v"><CopyValue value={server.playAddress ?? server.address} title="Copy the player address" /></span>
            </div>
            <div className="info-row"><span className="k">Port</span><span className="v mono">{server.port}</span></div>
            <div className="info-row"><span className="k">Query port</span><span className="v mono">{data.raw.queryPort ?? "disabled"}</span></div>
            <div className="info-row"><span className="k">RCON</span><span className="v">{data.raw.rconPasswordSet ? <Pill tone="amber">configured</Pill> : <Pill tone="neutral">disabled</Pill>}</span></div>
            <div className="info-row"><span className="k">Server port managed by</span><span className="v">RSLMC allocation</span></div>
          </div>
          <div style={{ padding: "10px 14px", borderTop: "1px solid var(--border)" }} className="text-xs faint">
            The port is owned by RSLMC's allocation table, so server.properties cannot silently drift from the firewall rules.
          </div>
        </Card>

        <Card title="Public address" icon={<Link2 size={12} />}>
          <div className="stack" style={{ gap: 10 }}>
            <div className="text-xs faint" style={{ lineHeight: 1.6 }}>
              Use this when players connect through a tunnel or port-forwarding tool (<span className="mono">playit.gg</span>,
              <span className="mono"> ngrok</span>, FRP…). Whatever you enter here is shown — and copied — as the server address
              across the whole panel, instead of the internal IP and port.
            </div>
            <div className="form-grid">
              <Field label="Domain or IP" hint="Optional. Leave empty to keep showing the internal address.">
                <Input
                  placeholder="something.playit.gg"
                  value={publicHost}
                  onChange={(event) => setPublicHost(event.target.value)}
                  disabled={!can("server.settings")}
                />
              </Field>
              <Field label="Public port" hint="Optional — leave empty for tools that use the default port (the address is then shown without a port).">
                <Input
                  type="number" min={1} max={65535} placeholder="default"
                  value={publicPort}
                  onChange={(event) => setPublicPort(event.target.value)}
                  disabled={!can("server.settings")}
                />
              </Field>
            </div>
            {server.publicHost ? (
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <span className="text-xs faint">Players join with</span>
                <CopyValue value={server.playAddress ?? server.address} title="Copy the player address" />
                <span className="text-xs faint">internal <span className="mono">{server.internalAddress ?? `${server.bindIp}:${server.port}`}</span></span>
              </div>
            ) : (
              <div className="text-xs faint">Currently showing the internal address <span className="mono">{server.internalAddress ?? `${server.bindIp}:${server.port}`}</span>.</div>
            )}
            <div className="row" style={{ gap: 8 }}>
              <Button icon={<Save size={13} />} loading={savingPublic} disabled={!can("server.settings")} onClick={() => void savePublicAddress()}>
                Save public address
              </Button>
              {server.publicHost ? (
                <Button
                  variant="ghost"
                  disabled={!can("server.settings")}
                  onClick={() => { setPublicHost(""); setPublicPort(""); void savePublicAddress(); }}
                >
                  Clear
                </Button>
              ) : null}
            </div>
          </div>
        </Card>

        <Card title="External reachability" icon={<ShieldAlert size={12} />}>
          <Banner tone={wildcard ? "warning" : "info"} title={wildcard ? "Listening on all interfaces" : "Bound to a specific interface"}>
            RSLMC verifies that the port is free and bound locally. It cannot verify your firewall or NAT rules — a locally-bound port is not automatically reachable from the internet.
          </Banner>
          <div className="stack" style={{ marginTop: 10, fontSize: 12, color: "var(--text-dim)", lineHeight: 1.6 }}>
            <div>1. Allow TCP <span className="mono">{server.port}</span> in the host firewall (ufw/firewalld/Windows Defender).</div>
            <div>2. Forward that port on your router if the host is behind NAT.</div>
            <div>3. Never expose RCON or the panel port publicly — use a VPN or SSH tunnel.</div>
          </div>
        </Card>

        <Card title="Allocations" icon={<Network size={12} />} bodyClass="tight">
          <table className="table">
            <thead><tr><th>IP</th><th>Port</th><th>Alias</th><th>Notes</th></tr></thead>
            <tbody>
              {allocations.length === 0 ? (
                <tr><td colSpan={4} className="faint text-xs">No additional allocations.</td></tr>
              ) : allocations.map((allocation) => (
                <tr key={allocation.id}>
                  <td className="mono text-xs">{allocation.ip}</td>
                  <td className="mono text-xs">{allocation.port}{allocation.is_primary ? <Pill tone="green">primary</Pill> : null}</td>
                  <td className="text-xs">{allocation.ip_alias ?? "—"}</td>
                  <td className="text-xs faint">{allocation.notes ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ padding: 12, borderTop: "1px solid var(--border)" }}>
            <div className="form-grid">
              <Field label="IP address"><Input value={newIp} onChange={(event) => setNewIp(event.target.value)} /></Field>
              <Field label="Port"><Input type="number" min={1} max={65535} value={newPort} onChange={(event) => setNewPort(Number(event.target.value))} /></Field>
            </div>
            <Button style={{ marginTop: 10 }} icon={<Plus size={13} />} loading={busy} onClick={() => void addAllocation()} disabled={!can("server.allocations")}>
              Add allocation
            </Button>
          </div>
        </Card>

        <Card title="Proxy forwarding" icon={<Wifi size={12} />}>
          <div className="stack" style={{ gap: 10 }}>
            <div className="text-xs faint" style={{ lineHeight: 1.6 }}>
              If this server sits behind a Velocity or BungeeCord proxy, use the proxy's forwarding settings in <span className="mono">server.properties</span>:
            </div>
            <div className="code-block">{`online-mode=false
prevent-proxy-connections=false
settings.velocity-support.enabled=true
settings.velocity-support.secret=<from proxy forwarding.secret>`}</div>
            <Banner tone="warning" title="Security">
              Turning off online-mode allows username impersonation. Only do it when a proxy enforces authentication, and keep the forwarding secret out of screenshots and logs.
            </Banner>
          </div>
        </Card>
      </div>
    </>
  );
}

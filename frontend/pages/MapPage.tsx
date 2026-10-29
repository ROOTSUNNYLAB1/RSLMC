import { useEffect, useState } from "react";
import { ExternalLink, Map as MapIcon, RefreshCw, Compass, Layers, AlertTriangle } from "lucide-react";
import type { ServerSummary } from "../../src/shared/types";
import { Banner, Button, Card, EmptyState, Loading, PageHeader, Pill, StatCard } from "../components/ui";
import { api } from "../lib/api";
import { useSession, useToast } from "../lib/app";
import { formatBytes, relativeTime } from "../lib/format";

interface MapResponse {
  config: {
    serverId: number; provider: string; status: string; progress: number;
    publicUrl: string | null; worlds: { name: string; dimension: string }[];
    note: string | null; lastUpdate: string | null;
  };
  renderedMaps: number;
  maps: { id: string; sizeBytes: number }[];
  webRootExists: boolean;
  bluemapInstalled: boolean;
}

export function MapPage({ server }: { server: ServerSummary }) {
  const { can } = useSession();
  const toast = useToast();
  const [data, setData] = useState<MapResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setData(await api.get<MapResponse>(`/api/servers/${server.id}/map`));
    } catch (err) {
      toast.fromError(err, "Could not read the map configuration");
    }
  };

  useEffect(() => { void load(); }, [server.id]);

  const setup = async () => {
    setBusy(true);
    try {
      const result = await api.post<{ message: string }>(`/api/servers/${server.id}/map/setup`);
      toast.success("BlueMap installed", result.message);
      await load();
    } catch (err) {
      toast.fromError(err, "Could not install BlueMap");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Map"
        icon={<MapIcon size={19} />}
        subtitle={<>World map for <strong style={{ color: "var(--text)" }}>{server.name}</strong> · rendered from your real world data</>}
        actions={<Button icon={<RefreshCw size={14} />} onClick={() => void load()}>Refresh status</Button>}
      />

      {!data ? <Loading label="Reading map configuration…" /> : (
        <>
          <div className="stat-grid" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
            <StatCard label="Renderer" icon={<Layers size={11} />} accent="var(--blue)" value={data.config.provider === "none" ? "None" : data.config.provider} meta={<span>{data.bluemapInstalled ? "plugin detected" : "plugin not installed"}</span>} />
            <StatCard label="Status" icon={<Compass size={11} />} accent="var(--green)" value={data.config.status.replace(/_/g, " ")} meta={<span>{data.renderedMaps} map folder(s) on disk</span>} />
            <StatCard label="Last update" icon={<RefreshCw size={11} />} accent="var(--amber)" value={data.config.lastUpdate ? relativeTime(data.config.lastUpdate) : "never"} meta={<span>renderer output</span>} />
          </div>

          {data.webRootExists || data.renderedMaps > 0 ? (
            <Card
              title="Rendered maps"
              icon={<MapIcon size={12} />}
              bodyClass="tight"
              actions={<Button size="sm" variant="primary" icon={<ExternalLink size={12} />} onClick={() => window.open(`/servers/${server.id}/map/view`, "_blank", "noreferrer")}>Open map</Button>}
            >
              <div className="info-list">
                {data.maps.length === 0 ? (
                  <div className="info-row"><span className="k">map folders</span><span className="v text-xs faint">The renderer has not written any map folders yet.</span></div>
                ) : data.maps.map((map) => (
                  <div className="info-row" key={map.id}>
                    <span className="k mono text-xs">{map.id}</span>
                    <span className="v text-xs">{formatBytes(map.sizeBytes)}</span>
                  </div>
                ))}
              </div>
              <div style={{ padding: "10px 14px", borderTop: "1px solid var(--border)" }} className="text-xs faint">
                Rendered by BlueMap into <span className="mono">bluemap/web</span>. The viewer is served by RSLMC from that directory — no external map host is involved.
              </div>
            </Card>
          ) : (
            <Card title="Map renderer" icon={<MapIcon size={12} />}>
              <EmptyState
                icon={<Compass size={18} />}
                title={data.bluemapInstalled ? "BlueMap is installed but has not rendered yet" : "No map renderer configured"}
                description={
                  data.bluemapInstalled
                    ? "Start the server so BlueMap can generate its web output. Rendering happens in the server process and progress appears in the console."
                    : "RSLMC can install BlueMap from Modrinth for Paper, Purpur and Folia servers. Rendering uses your actual world files — RSLMC will not draw a fake map from a seed."
                }
                action={
                  <Button variant="primary" onClick={() => void setup()} loading={busy} disabled={!can("server.plugins") || !["paper", "purpur", "folia"].includes(server.software)}>
                    Install BlueMap
                  </Button>
                }
              />
              {!["paper", "purpur", "folia"].includes(server.software) ? (
                <Banner tone="warning" title="Unsupported software for automatic setup">
                  Automatic BlueMap installation is only offered for Paper, Purpur and Folia. On {server.software} install the matching BlueMap mod manually through the Plugins page.
                </Banner>
              ) : null}
            </Card>
          )}

          <Banner tone="info" title="Why there is no instant map">
            A seed does not contain generated chunks or structures — a real map requires rendering your world files. RSLMC shows the renderer's actual status rather than an obviously fake interactive map.
          </Banner>
          {data.config.note ? <Banner tone="info" title="Renderer note">{data.config.note}</Banner> : null}
        </>
      )}
    </>
  );
}

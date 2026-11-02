import { useEffect, useState } from "react";
import { ExternalLink, Map as MapIcon, RefreshCw } from "lucide-react";
import type { ServerSummary } from "../../src/shared/types";
import { Banner, Button, Card, EmptyState, Loading, PageHeader, Pill } from "../components/ui";
import { api } from "../lib/api";
import { errorMessage } from "../lib/api";

interface MapStatus {
  config: { provider: string; status: string; note: string | null };
  renderedMaps: number;
  maps: { id: string; sizeBytes: number }[];
  webRootExists: boolean;
  bluemapInstalled: boolean;
}

/**
 * Renders the BlueMap web app straight out of the server directory through the panel's own
 * authenticated file route. If the renderer has not produced output yet we say so instead of
 * showing a fake map.
 */
export function MapViewPage({ server }: { server: ServerSummary }) {
  const [status, setStatus] = useState<MapStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    api.get<MapStatus>(`/api/servers/${server.id}/map`)
      .then(setStatus)
      .catch((err) => setError(errorMessage(err)));
  }, [server.id, reloadKey]);

  if (error) return <Banner tone="error" title="Could not read the map status">{error}</Banner>;
  if (!status) return <Loading label="Reading the renderer output…" minHeight={280} />;

  const ready = status.webRootExists || status.renderedMaps > 0;

  return (
    <>
      <PageHeader
        title="Map"
        icon={<MapIcon size={19} />}
        subtitle={<>Rendered world for <strong style={{ color: "var(--text)" }}>{server.name}</strong> · served from the server's own BlueMap output</>}
        actions={
          <>
            <Button icon={<RefreshCw size={14} />} onClick={() => setReloadKey((value) => value + 1)}>Refresh status</Button>
            {ready ? <Button icon={<ExternalLink size={14} />} onClick={() => window.open(`/api/servers/${server.id}/map/web/`, "_blank", "noreferrer")}>Open in new tab</Button> : null}
          </>
        }
      />

      {ready ? (
        <>
          <div className="row" style={{ gap: 8, marginBottom: 10 }}>
            <Pill tone="green" dot>renderer output found</Pill>
            <span className="text-xs faint">{status.maps.length} map folder(s): {status.maps.map((map) => map.id).join(", ") || "—"}</span>
          </div>
          <Card bodyClass="tight">
            {/*
              * The renderer's output is user content: any account that can write files on this server
              * could otherwise put a script there. The response is served with a CSP sandbox (opaque
              * origin) and the frame repeats that with the `sandbox` attribute, so the map can draw
              * itself but cannot read this panel's session or call its API.
              */}
            <iframe
              key={reloadKey}
              title={`Map for ${server.name}`}
              src={`/api/servers/${server.id}/map/web/`}
              sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock"
              style={{ width: "100%", height: "min(72vh, 780px)", border: 0, display: "block", background: "var(--bg)" }}
              referrerPolicy="no-referrer"
            />
          </Card>
          <div className="text-xs faint" style={{ marginTop: 8 }}>
            BlueMap loads terrain, textures and player markers from the files it rendered on this host. The viewer runs sandboxed, so it cannot reach your panel session. If it stays blank, the renderer has not finished writing its output — check the console.
          </div>
        </>
      ) : (
        <Card title="No rendered map yet" icon={<MapIcon size={12} />}>
          <EmptyState
            icon={<MapIcon size={18} />}
            title={status.bluemapInstalled ? "BlueMap is installed but has not rendered" : "No map renderer configured"}
            description={status.bluemapInstalled
              ? "Start the server so BlueMap can generate bluemap/web. Rendering progress appears in the console, and this page switches to the live map once the output exists."
              : "Install BlueMap from the Map page for Paper, Purpur or Folia servers, then start the server. RSLMC will not invent a map from a seed."}
          />
        </Card>
      )}
    </>
  );
}

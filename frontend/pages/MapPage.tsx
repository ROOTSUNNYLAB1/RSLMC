import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle, Compass, Copy, ExternalLink, Layers, Map as MapIcon, Mountain, RefreshCw, RotateCw, Sprout,
} from "lucide-react";
import type { ServerSummary } from "../../src/shared/types";
import { Banner, Button, Card, CopyValue, EmptyState, Field, Input, Loading, PageHeader, Pill, Select, StatCard, Tabs } from "../components/ui";
import { api } from "../lib/api";
import { useSession, useToast } from "../lib/app";
import { formatBytes, relativeTime } from "../lib/format";

type Dimension = "overworld" | "nether" | "end";

interface SeedWorld {
  folder: string;
  name: string;
  seed: string | null;
  lastUpdated: string | null;
  dimensions: { nether: boolean; end: boolean };
  isMain: boolean;
  links: Record<Dimension, string> | null;
}

interface SeedMapResponse {
  server: { id: number; name: string; software: string; mcVersion: string };
  platform: string;
  platformIsExact: boolean;
  dimensions: Array<{ id: Dimension; label: string }>;
  knownPlatforms: string[];
  embeddable: boolean;
  embedBlockedBy: string;
  primaryWorld: SeedWorld | null;
  worlds: SeedWorld[];
  levelName: string;
}

interface RendererResponse {
  config: { provider: string; status: string; lastUpdate: string | null };
  renderedMaps: number;
  maps: { id: string; sizeBytes: number }[];
  webRootExists: boolean;
  bluemapInstalled: boolean;
}

const ZOOMS = [
  { value: "0.25", label: "Far" },
  { value: "0.5", label: "Default" },
  { value: "1", label: "Close" },
  { value: "2", label: "Street level" },
];

const DIMENSION_ICONS: Record<Dimension, ReactNode> = {
  overworld: <Mountain size={11} />,
  nether: <Compass size={11} />,
  end: <Sprout size={11} />,
};

export function MapPage({ server }: { server: ServerSummary }) {
  const { can } = useSession();
  const toast = useToast();
  const [data, setData] = useState<SeedMapResponse | null>(null);
  const [renderer, setRenderer] = useState<RendererResponse | null>(null);
  const [rendererBusy, setRendererBusy] = useState(false);
  const [world, setWorld] = useState<string | null>(null);
  const [dimension, setDimension] = useState<Dimension>("overworld");
  const [x, setX] = useState("0");
  const [z, setZ] = useState("0");
  const [zoom, setZoom] = useState("0.5");

  const load = async () => {
    try {
      const [seedMap, mapState] = await Promise.all([
        api.get<SeedMapResponse>(`/api/servers/${server.id}/seed-map`),
        api.get<RendererResponse>(`/api/servers/${server.id}/map`).catch(() => null),
      ]);
      setData(seedMap);
      setRenderer(mapState);
      setWorld((current) => current ?? seedMap.primaryWorld?.folder ?? null);
    } catch (err) {
      toast.fromError(err, "Could not read the world seed");
    }
  };

  useEffect(() => { void load(); }, [server.id]);

  const activeWorld = useMemo(
    () => data?.worlds.find((entry) => entry.folder === world) ?? data?.primaryWorld ?? null,
    [data, world],
  );

  /*
   * The URL is rebuilt here rather than taken from the API so the coordinate and zoom controls feel
   * immediate. It has the same shape as the links the server returns (which are what the tests and the
   * copy button use): seed, platform, dimension, x, z, zoom.
   */
  const url = useMemo(() => {
    if (!activeWorld?.seed) return null;
    const params = new URLSearchParams({
      seed: activeWorld.seed,
      platform: data?.platform ?? "java_1_21_4",
      dimension,
      x: String(Math.round(Number(x) || 0)),
      z: String(Math.round(Number(z) || 0)),
      zoom,
    });
    return `https://www.chunkbase.com/apps/seed-map#${params.toString()}`;
  }, [activeWorld, data?.platform, dimension, x, z, zoom]);

  const linkFor = (target: Dimension) => {
    if (!activeWorld?.seed) return null;
    const params = new URLSearchParams({
      seed: activeWorld.seed,
      platform: data?.platform ?? "",
      dimension: target,
      x: String(Math.round(Number(x) || 0)),
      z: String(Math.round(Number(z) || 0)),
      zoom,
    });
    return `https://www.chunkbase.com/apps/seed-map#${params.toString()}`;
  };

  const openMap = () => {
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  };

  /** Jumps straight to another dimension without losing the seed, coordinates or zoom. */
  const openDimension = (target: Dimension) => {
    const link = linkFor(target);
    if (link) window.open(link, "_blank", "noopener,noreferrer");
  };

  const setupRenderer = async () => {
    setRendererBusy(true);
    try {
      const result = await api.post<{ message: string }>(`/api/servers/${server.id}/map/setup`);
      toast.success("BlueMap installed", result.message);
      await load();
    } catch (err) {
      toast.fromError(err, "Could not install BlueMap");
    } finally {
      setRendererBusy(false);
    }
  };

  const copy = async (value: string, what: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${what} copied`);
    } catch {
      // Plain-HTTP pages have no async clipboard; the text is selectable in the field anyway.
      toast.error("Could not copy", "Select the value and copy it manually.");
    }
  };

  return (
    <>
      <PageHeader
        title="Map"
        icon={<MapIcon size={19} />}
        subtitle={
          activeWorld?.seed ? (
            <>Seed map for <strong style={{ color: "var(--text)" }}>{server.name}</strong> · drawn from the seed in <span className="mono">level.dat</span></>
          ) : (
            <>Seed map for <strong style={{ color: "var(--text)" }}>{server.name}</strong> · no readable seed yet</>
          )
        }
        status={activeWorld?.seed ? <Pill tone="green" dot>Seed found</Pill> : <Pill tone="amber" dot>No seed yet</Pill>}
        actions={<Button icon={<RefreshCw size={14} />} onClick={() => void load()}>Refresh</Button>}
      />

      {!data ? <Loading label="Reading the world seed…" /> : (
        <>
          <div className="stat-grid" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
            <StatCard
              label="Seed"
              icon={<Sprout size={11} />}
              accent="var(--green)"
              value={<span className="mono" style={{ fontSize: 18 }}>{activeWorld?.seed ?? "—"}</span>}
              meta={<span>{activeWorld ? `from ${activeWorld.folder}/level.dat` : "start the server once to create a world"}</span>}
            />
            <StatCard
              label="Version"
              icon={<Layers size={11} />}
              accent="var(--blue)"
              value={data.server.mcVersion}
              meta={
                <span>
                  {data.platformIsExact
                    ? `exact Chunkbase profile ${data.platform}`
                    : `closest Chunkbase profile ${data.platform} — ${data.server.mcVersion} is not published there`}
                </span>
              }
            />
            <StatCard
              label="World updated"
              icon={<RotateCw size={11} />}
              accent="var(--amber)"
              value={activeWorld?.lastUpdated ? relativeTime(activeWorld.lastUpdated) : "never"}
              meta={<span>{data.worlds.length} world folder(s) on disk</span>}
            />
          </div>

          <Card
            title="Seed map"
            icon={<MapIcon size={12} />}
            actions={
              <div className="row" style={{ gap: 8 }}>
                <Button size="sm" icon={<Copy size={12} />} disabled={!url} onClick={() => void copy(url!, "Seed map link")}>Copy link</Button>
                <Button size="sm" variant="primary" icon={<ExternalLink size={12} />} disabled={!url} onClick={openMap}>
                  Open seed map
                </Button>
              </div>
            }
          >
            {!data.worlds.length ? (
              <EmptyState
                icon={<Compass size={18} />}
                title="This server has no world yet"
                description="A seed exists only once Minecraft has generated the world. Start the server once, then come back — the seed is read from level.dat, it is never guessed."
              />
            ) : (
              <>
                <div className="form-grid" style={{ padding: "14px 16px 4px" }}>
                  <Field label="World" hint="Read from level.dat of the folder you pick">
                    <Select value={activeWorld?.folder ?? ""} onChange={(event) => setWorld(event.target.value)}>
                      {data.worlds.map((entry) => (
                        <option key={entry.folder} value={entry.folder}>
                          {entry.folder}{entry.isMain ? " (level-name)" : ""}{entry.seed ? "" : " — no seed"}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Dimension">
                    <Select value={dimension} onChange={(event) => setDimension(event.target.value as Dimension)}>
                      {data.dimensions.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
                    </Select>
                  </Field>
                  <Field label="X" hint="Block coordinate">
                    <Input value={x} onChange={(event) => setX(event.target.value.replace(/[^-\d]/g, ""))} inputMode="numeric" />
                  </Field>
                  <Field label="Z" hint="Block coordinate">
                    <Input value={z} onChange={(event) => setZ(event.target.value.replace(/[^-\d]/g, ""))} inputMode="numeric" />
                  </Field>
                  <Field label="Zoom">
                    <Select value={zoom} onChange={(event) => setZoom(event.target.value)}>
                      {ZOOMS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label} ({entry.value})</option>)}
                    </Select>
                  </Field>
                </div>

                <div style={{ padding: "4px 16px 14px" }}>
                  <div className="text-xs faint" style={{ marginBottom: 6 }}>Link that will open</div>
                  {url ? (
                    <CopyValue value={url} />
                  ) : (
                    <div className="text-xs faint">
                      No link — there is no seed to put in it. Start the server once so Minecraft
                      writes a <span className="mono">level.dat</span>, then press Refresh.
                    </div>
                  )}
                </div>

                {activeWorld?.seed ? (
                  <div className="row" style={{ gap: 8, padding: "0 16px 14px", flexWrap: "wrap", alignItems: "center" }}>
                    <span className="text-xs faint">Open in a new tab:</span>
                    {data.dimensions.map((entry) => (
                      <Button
                        key={entry.id}
                        size="sm"
                        icon={DIMENSION_ICONS[entry.id]}
                        onClick={() => openDimension(entry.id)}
                      >
                        {entry.label}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </>
            )}
          </Card>

          {/* The honest part: the site cannot be framed, so say it once, plainly, and explain the button. */}
          <Banner
            tone="info"
            title={data.embeddable ? "Opens in a new tab" : "The seed map opens in a new tab, on purpose"}
          >
            The seed map is drawn by <a className="link" href="https://www.chunkbase.com/apps/seed-map" target="_blank" rel="noreferrer">chunkbase.com</a>,
            and its server refuses to be framed — <span className="mono">{data.embedBlockedBy}</span> — so no browser will render it inside this
            panel, no matter what the panel does. <strong>Open seed map</strong> therefore launches your exact world — correct seed,
            version, dimension and coordinates — in a new tab. Nothing about your world is uploaded: the seed travels in the URL fragment
            (<span className="mono">#…</span>), which browsers never send to a server, and only the page you open sees it.
          </Banner>

          {activeWorld && !activeWorld.seed ? (
            <Banner tone="warning" title="level.dat has no seed inside">
              {activeWorld.folder} exists but its level.dat could not be read as NBT, so there is no seed to draw.
              A world that has never been generated (or a level.dat from a much older format) looks exactly like this. Start the server once
              so Minecraft writes a fresh level.dat.
            </Banner>
          ) : null}

          {data.worlds.length > 1 ? (
            <Card title="All worlds" icon={<Layers size={12} />} bodyClass="tight">
              <table className="table">
                <thead><tr><th>World</th><th>Seed</th><th>Updated</th><th /></tr></thead>
                <tbody>
                  {data.worlds.map((entry) => (
                    <tr key={entry.folder}>
                      <td className="mono text-xs">{entry.folder}{entry.isMain ? <Pill tone="green">main</Pill> : null}</td>
                      <td className="mono text-xs">{entry.seed ?? <span className="faint">—</span>}</td>
                      <td className="text-xs">{entry.lastUpdated ? relativeTime(entry.lastUpdated) : "never"}</td>
                      <td style={{ textAlign: "right" }}>
                        <Button
                          size="sm"
                          icon={<ExternalLink size={11} />}
                          disabled={!entry.links}
                          onClick={() => { if (entry.links) window.open(entry.links[dimension], "_blank", "noopener,noreferrer"); }}
                        >
                          Open
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ) : null}

          {renderer ? (
            <Card
              title="Rendered map (BlueMap)"
              icon={<Layers size={12} />}
              actions={
                renderer.webRootExists || renderer.renderedMaps > 0 ? (
                  <Button size="sm" variant="primary" icon={<ExternalLink size={12} />} onClick={() => window.open(`/servers/${server.id}/map/view`, "_blank", "noreferrer")}>
                    Open rendered map
                  </Button>
                ) : undefined
              }
            >
              <div className="info-list">
                <div className="info-row">
                  <span className="k">Renderer</span>
                  <span className="v">{renderer.config.provider === "none" ? "none" : renderer.config.provider}</span>
                </div>
                <div className="info-row">
                  <span className="k">Status</span>
                  <span className="v">{renderer.config.status.replace(/_/g, " ")} · {renderer.renderedMaps} folder(s)</span>
                </div>
                <div className="info-row">
                  <span className="k">Last render</span>
                  <span className="v">{renderer.config.lastUpdate ? relativeTime(renderer.config.lastUpdate) : "never"}</span>
                </div>
                {renderer.maps.map((map) => (
                  <div className="info-row" key={map.id}>
                    <span className="k mono text-xs">{map.id}</span>
                    <span className="v text-xs">{formatBytes(map.sizeBytes)}</span>
                  </div>
                ))}
              </div>
              <div style={{ padding: "10px 14px", borderTop: "1px solid var(--border)" }} className="text-xs faint">
                Different question, different answer: the seed map <em>predicts</em> terrain from the seed, while BlueMap <em>renders</em> the chunks
                that actually exist on disk. Use the renderer when you want to see what players have built.
              </div>
              {!renderer.bluemapInstalled && !(renderer.renderedMaps > 0) ? (
                <div style={{ padding: "0 14px 14px" }}>
                  <Button
                    variant="primary"
                    onClick={() => void setupRenderer()}
                    loading={rendererBusy}
                    disabled={!can("server.plugins") || !["paper", "purpur", "folia"].includes(server.software)}
                  >
                    Install BlueMap
                  </Button>
                  {!["paper", "purpur", "folia"].includes(server.software) ? (
                    <p className="text-xs faint" style={{ marginTop: 8 }}>
                      <AlertTriangle size={11} /> Automatic setup is only offered for Paper, Purpur and Folia. On {server.software}, install the
                      matching BlueMap mod from the Plugins page.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </Card>
          ) : null}
        </>
      )}
    </>
  );
}

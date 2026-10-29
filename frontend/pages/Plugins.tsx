import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownToLine, Download, ExternalLink, Package, Plug, RefreshCw, Search, Trash2, Upload, ShieldAlert,
} from "lucide-react";
import type { ServerSummary } from "../../src/shared/types";
import { Banner, Button, Card, ConfirmDialog, EmptyState, Input, Loading, Modal, PageHeader, Pill, Select, StatCard, Tabs } from "../components/ui";
import { api, errorMessage } from "../lib/api";
import { useSession, useToast } from "../lib/app";
import { formatBytes, relativeTime } from "../lib/format";
import { summariseGameVersions, summariseLoaders } from "../lib/mc-version";

interface InstalledPlugin {
  id: number; name: string; version: string | null; fileName: string; fileSize: number;
  source: string; targetDir: string; enabled: boolean | null; projectId: string | null;
  updateVersion: string | null; installedAt: string;
}

interface RecommendedEntry {
  slug: string; title: string; note: string; installed: boolean;
}

interface SearchHit {
  project_id: string; slug: string; title: string; description: string; downloads: number;
  icon_url: string | null; categories: string[]; date_modified: string; versions: string[];
}

interface VersionEntry {
  id: string; name: string; version_number: string; version_type: string;
  game_versions: string[]; loaders: string[]; downloads: number; date_published: string;
  files: { filename: string; size: number; primary: boolean }[];
  dependencies: { project_id: string | null; dependency_type: string }[];
}

export function PluginsPage({ server }: { server: ServerSummary }) {
  const { can } = useSession();
  const toast = useToast();
  const [tab, setTab] = useState<"installed" | "marketplace">("installed");
  const [installed, setInstalled] = useState<InstalledPlugin[] | null>(null);
  const [directory, setDirectory] = useState("plugins");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [sort, setSort] = useState<"relevance" | "downloads" | "updated">("relevance");
  const [selected, setSelected] = useState<SearchHit | null>(null);
  const [versions, setVersions] = useState<VersionEntry[] | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<InstalledPlugin | null>(null);
  const [checking, setChecking] = useState(false);
  const [recommended, setRecommended] = useState<RecommendedEntry[]>([]);
  const [installingRecommended, setInstallingRecommended] = useState(false);

  const loadInstalled = async () => {
    try {
      const result = await api.get<{ data: InstalledPlugin[]; directory: string; recommended?: RecommendedEntry[] }>(
        `/api/servers/${server.id}/plugins`,
      );
      setInstalled(result.data);
      setDirectory(result.directory);
      setRecommended(result.recommended ?? []);
    } catch (err) {
      toast.fromError(err, "Could not load installed plugins");
      setInstalled([]);
    }
  };

  useEffect(() => { void loadInstalled(); }, [server.id]);

  const installRecommended = async () => {
    setInstallingRecommended(true);
    try {
      const result = await api.post<{ installed: { title: string; version: string }[]; alreadyPresent: string[]; failed: { title: string; message: string }[] }>(
        `/api/servers/${server.id}/plugins/recommended`,
      );
      if (result.installed.length > 0) {
        toast.success(
          "Recommended plugins installed",
          result.installed.map((entry) => `${entry.title} ${entry.version}`).join(", ") + " — restart the server to load them.",
        );
      }
      if (result.failed.length > 0) {
        toast.warn("Some plugins could not be installed", result.failed.map((entry) => `${entry.title}: ${entry.message}`).join(" "));
      }
      if (result.installed.length === 0 && result.failed.length === 0) {
        toast.success("Already installed", "Every recommended plugin is present already.");
      }
      await loadInstalled();
    } catch (err) {
      toast.fromError(err, "Could not install the recommended plugins");
    } finally {
      setInstallingRecommended(false);
    }
  };

  const search = async () => {
    setSearching(true);
    try {
      const params = new URLSearchParams({
        query, software: server.software, gameVersion: server.mcVersion, index: sort, limit: "24",
      });
      const result = await api.get<{ hits: SearchHit[] }>(`/api/marketplace/search?${params.toString()}`);
      setResults(result.hits);
    } catch (err) {
      toast.fromError(err, "Marketplace search failed");
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  useEffect(() => {
    if (tab === "marketplace" && results === null) void search();
  }, [tab]);

  const openProject = async (hit: SearchHit) => {
    setSelected(hit);
    setVersions(null);
    try {
      const result = await api.get<{ data: VersionEntry[] }>(
        `/api/marketplace/project/${hit.project_id}/versions?gameVersion=${server.mcVersion}&software=${server.software}`,
      );
      setVersions(result.data);
    } catch (err) {
      toast.fromError(err, "Could not load versions");
      setVersions([]);
    }
  };

  const install = async (versionId: string) => {
    setInstalling(versionId);
    try {
      const result = await api.post<{ installed: { file: string }[]; warnings: string[]; skipped: string[] }>(
        `/api/servers/${server.id}/plugins/install`, { versionId },
      );
      toast.success(`${result.installed.length} file(s) installed`, "Restart the server to load the new " + directory + ".");
      if (result.warnings.length > 0) toast.warn("Compatibility warnings", result.warnings.join(" · "));
      setSelected(null);
      await loadInstalled();
    } catch (err) {
      toast.fromError(err, "Installation failed");
    } finally {
      setInstalling(null);
    }
  };

  const checkUpdates = async () => {
    setChecking(true);
    try {
      const result = await api.post<{ data: { fileName: string; current: string | null; latest: string | null }[] }>(`/api/servers/${server.id}/plugins/updates`);
      const updates = result.data.filter((entry) => entry.latest && entry.latest !== entry.current);
      toast.success(
        updates.length > 0 ? `${updates.length} update(s) available` : "Everything is up to date",
        updates.map((entry) => `${entry.fileName}: ${entry.current ?? "?"} → ${entry.latest}`).join(", ") || undefined,
      );
      await loadInstalled();
    } catch (err) {
      toast.fromError(err, "Update check failed");
    } finally {
      setChecking(false);
    }
  };

  const installedCount = installed?.length ?? 0;
  const updatable = (installed ?? []).filter((plugin) => plugin.updateVersion && plugin.updateVersion !== plugin.version).length;

  return (
    <>
      <PageHeader
        title={directory === "mods" ? "Mods" : "Plugins"}
        icon={<Plug size={19} />}
        subtitle={<>Managed {directory} for <strong style={{ color: "var(--text)" }}>{server.name}</strong> · {server.software} {server.mcVersion}</>}
        actions={
          <>
            <Button icon={<RefreshCw size={14} />} loading={checking} onClick={() => void checkUpdates()} disabled={!can("server.plugins")}>Check updates</Button>
            <Button
              icon={<Upload size={14} />}
              onClick={() => {
                const input = document.createElement("input");
                input.type = "file";
                input.accept = ".jar";
                input.onchange = async () => {
                  const file = input.files?.[0];
                  if (!file) return;
                  const form = new FormData();
                  form.set("path", directory);
                  form.set("file", file);
                  form.set("overwrite", "true");
                  try {
                    await api.upload(`/api/servers/${server.id}/files/upload`, form);
                    toast.success("Uploaded", `${file.name} saved to ${directory}/`);
                    await loadInstalled();
                  } catch (err) { toast.fromError(err, "Upload failed"); }
                };
                input.click();
              }}
              disabled={!can("server.plugins")}
            >
              Upload JAR
            </Button>
          </>
        }
      />

      <div className="stat-grid" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        <StatCard label={`Installed ${directory}`} icon={<Package size={11} />} accent="var(--green)" value={installedCount} meta={<span>{formatBytes((installed ?? []).reduce((sum, plugin) => sum + plugin.fileSize, 0))} on disk</span>} />
        <StatCard label="Updates available" icon={<ArrowDownToLine size={11} />} accent="var(--amber)" value={updatable} meta={<span>verified against Modrinth</span>} />
        <StatCard label="Marketplace" icon={<Download size={11} />} accent="var(--blue)" value="Modrinth" meta={<span>official API · {server.mcVersion} + {server.software}</span>} />
      </div>

      {recommended.length > 0 && recommended.some((entry) => !entry.installed) ? (
        <Card
          title="Recommended for this server"
          icon={<ShieldAlert size={12} />}
          actions={
            <Button size="sm" loading={installingRecommended} onClick={() => void installRecommended()} disabled={!can("server.plugins")}>
              Install missing
            </Button>
          }
        >
          <div className="stack" style={{ gap: 8 }}>
            {recommended.map((entry) => (
              <div key={entry.slug} className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                <Pill tone={entry.installed ? "green" : "amber"}>{entry.installed ? "installed" : "missing"}</Pill>
                <div>
                  <div style={{ fontSize: 12.5 }}>{entry.title}</div>
                  <div className="text-xs faint">{entry.note}</div>
                </div>
              </div>
            ))}
            <div className="text-xs faint">
              Installed from Modrinth and matched to {server.software} {server.mcVersion}. They let clients on
              other Minecraft versions connect to this server. Restart is required to load them.
            </div>
          </div>
        </Card>
      ) : null}

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "installed", label: `Installed (${installedCount})` },
          { id: "marketplace", label: "Marketplace" },
        ]}
        right={tab === "marketplace" ? (
          <div className="row" style={{ gap: 6 }}>
            <div className="row" style={{ gap: 6 }}>
              <Search size={12} className="faint" />
              <input
                className="input" style={{ height: 27, width: 200 }} placeholder="Search Modrinth…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") void search(); }}
              />
            </div>
            <Select style={{ height: 27, width: 130 }} value={sort} onChange={(event) => { setSort(event.target.value as any); setTimeout(() => void search(), 0); }}>
              <option value="relevance">Relevance</option>
              <option value="downloads">Downloads</option>
              <option value="updated">Recently updated</option>
            </Select>
            <Button size="sm" onClick={() => void search()} loading={searching}>Search</Button>
          </div>
        ) : undefined}
      />

      {tab === "installed" ? (
        <Card bodyClass="tight">
          {installed === null ? <Loading label="Scanning the server directory…" /> : installed.length === 0 ? (
            <EmptyState
              icon={<Plug size={17} />}
              title={`No ${directory} installed`}
              description={`Use the Marketplace tab to install compatible ${directory} for ${server.software} ${server.mcVersion}, or upload a JAR manually.`}
              action={<Button variant="primary" onClick={() => setTab("marketplace")}>Browse Modrinth</Button>}
            />
          ) : (
            <table className="table">
              <thead>
                <tr><th>Name</th><th>Version</th><th>File</th><th>Size</th><th>Source</th><th>Installed</th><th className="actions">Actions</th></tr>
              </thead>
              <tbody>
                {installed.map((plugin) => (
                  <tr key={plugin.id}>
                    <td>
                      <strong>{plugin.name}</strong>
                      {plugin.updateVersion && plugin.updateVersion !== plugin.version ? (
                        <div><Pill tone="amber">update {plugin.updateVersion}</Pill></div>
                      ) : null}
                    </td>
                    <td>{plugin.version ?? <span className="faint">unknown</span>}</td>
                    <td className="mono text-xs">{plugin.fileName}</td>
                    <td>{formatBytes(plugin.fileSize)}</td>
                    <td><Pill tone={plugin.source === "modrinth" ? "blue" : "neutral"}>{plugin.source}</Pill></td>
                    <td className="text-xs">{relativeTime(plugin.installedAt)}</td>
                    <td className="actions">
                      {plugin.projectId ? (
                        <Button
                          size="sm" icon={<ExternalLink size={12} />}
                          onClick={() => window.open(`https://modrinth.com/project/${plugin.projectId}`, "_blank", "noreferrer")}
                        >
                          Project
                        </Button>
                      ) : null}
                      <Button size="sm" variant="danger" icon={<Trash2 size={12} />} onClick={() => setRemoveTarget(plugin)} disabled={!can("server.plugins")}>Remove</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div style={{ padding: "10px 14px", borderTop: "1px solid var(--border)" }} className="text-xs faint">
            A JAR being present does not mean it is enabled — Minecraft has no enable flag, so RSLMC reports “unknown” rather than guessing.
          </div>
        </Card>
      ) : (
        <Card bodyClass="tight">
          {results === null ? <Loading label="Searching Modrinth…" /> : results.length === 0 ? (
            <EmptyState icon={<Search size={17} />} title="No compatible projects found" description={`Nothing on Modrinth matched ${server.software} ${server.mcVersion}. Try a different search or check the version filter.`} />
          ) : (
            <div className="grid grid-3" style={{ padding: 12, gap: 9 }}>
              {results.map((hit) => (
                <button
                  key={hit.project_id}
                  className="card"
                  style={{ textAlign: "left", padding: 12, cursor: "pointer" }}
                  onClick={() => void openProject(hit)}
                >
                  <div className="row" style={{ gap: 9, alignItems: "flex-start" }}>
                    {hit.icon_url ? (
                      <img src={hit.icon_url} alt="" width={32} height={32} style={{ borderRadius: 6, flex: "none" }} />
                    ) : (
                      <div className="player-avatar" style={{ width: 32, height: 32 }}><Package size={14} /></div>
                    )}
                    <div style={{ minWidth: 0 }}>
                      <div className="row" style={{ gap: 6 }}><strong style={{ fontSize: 12.5 }}>{hit.title}</strong></div>
                      <div className="text-xs faint" style={{ marginTop: 2 }}>{hit.downloads.toLocaleString()} downloads</div>
                    </div>
                  </div>
                  <p className="text-xs faint" style={{ margin: "8px 0 0", lineHeight: 1.5, maxHeight: 46, overflow: "hidden" }}>{hit.description}</p>
                  <div className="row" style={{ gap: 4, marginTop: 8, flexWrap: "wrap" }}>
                    {hit.categories.slice(0, 3).map((category) => <Pill key={category} tone="neutral">{category}</Pill>)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>
      )}

      <Modal
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected?.title ?? "Project"}
        size="wide"
        footer={<Button onClick={() => setSelected(null)}>Close</Button>}
      >
        {selected ? (
          <>
            <div className="row" style={{ alignItems: "flex-start", gap: 10 }}>
              {selected.icon_url ? <img src={selected.icon_url} alt="" width={42} height={42} style={{ borderRadius: 8 }} /> : null}
              <div>
                <div className="text-sm">{selected.description}</div>
                <div className="row text-xs faint" style={{ gap: 10, marginTop: 6 }}>
                  <span>{selected.downloads.toLocaleString()} downloads</span>
                  <span>updated {relativeTime(selected.date_modified)}</span>
                </div>
              </div>
            </div>

            {versions === null ? <Loading label="Loading compatible versions…" minHeight={100} /> : versions.length === 0 ? (
              <Banner tone="warning" title="No compatible version">
                This project has no release matching {server.software} {server.mcVersion}. RSLMC will not install an incompatible artifact.
              </Banner>
            ) : (
              <div className="card" style={{ maxHeight: 320, overflowY: "auto" }}>
                <table className="table">
                  <thead><tr><th>Version</th><th>Type</th><th>Game versions</th><th>Loaders</th><th className="actions" /></tr></thead>
                  <tbody>
                    {versions.map((version) => (
                      <tr key={version.id}>
                        <td><strong>{version.version_number}</strong><div className="text-xs faint">{relativeTime(version.date_published)}</div></td>
                        <td><Pill tone={version.version_type === "release" ? "green" : version.version_type === "beta" ? "amber" : "red"}>{version.version_type}</Pill></td>
                        <td className="text-xs">
                          {(() => {
                            // Never slice the raw array: Modrinth lists versions oldest-first, which
                            // showed "1.8, 1.8.1, 1.8.2, 1.8.3" for every project. Describe the
                            // support range and say plainly whether this build fits this server.
                            const summary = summariseGameVersions(version.game_versions, server.mcVersion);
                            return (
                              <span
                                className="row"
                                style={{ gap: 6, whiteSpace: "nowrap" }}
                                title={`Supports ${summary.total} Minecraft version${summary.total === 1 ? "" : "s"}: ${version.game_versions.join(", ")}`}
                              >
                                {summary.supportsCurrent ? <Pill tone="green">{`✓ ${server.mcVersion}`}</Pill> : null}
                                <span className={summary.supportsCurrent ? "faint" : undefined}>{summary.range}</span>
                              </span>
                            );
                          })()}
                        </td>
                        <td className="text-xs">
                          {(() => {
                            const loaders = summariseLoaders(version.loaders);
                            return (
                              <span title={version.loaders.join(", ")}>
                                {loaders.shown}
                                {loaders.hidden.length ? <span className="faint"> +{loaders.hidden.length}</span> : null}
                              </span>
                            );
                          })()}
                        </td>
                        <td className="actions">
                          <Button
                            size="sm"
                            variant="primary"
                            icon={<Download size={12} />}
                            loading={installing === version.id}
                            disabled={!can("server.plugins")}
                            onClick={() => void install(version.id)}
                          >
                            Install
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {versions?.some((version) => version.dependencies.some((dep) => dep.dependency_type === "required")) ? (
              <div className="row text-xs faint" style={{ gap: 6 }}>
                <ShieldAlert size={12} />
                Required dependencies are installed automatically. Downloads are hash-verified and never executed during installation.
              </div>
            ) : null}
          </>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={removeTarget !== null}
        title={`Remove ${removeTarget?.name}?`}
        confirmLabel="Remove"
        message={<>The file <span className="mono">{removeTarget?.fileName}</span> is deleted and an automatic backup is created first. This cannot be undone.</>}
        onClose={() => setRemoveTarget(null)}
        onConfirm={async () => {
          if (!removeTarget) return;
          try {
            await api.delete(`/api/servers/${server.id}/plugins/${removeTarget.id}`);
            toast.success("Removed", `${removeTarget.name} deleted. Restart the server to apply.`);
            setRemoveTarget(null);
            await loadInstalled();
          } catch (err) {
            toast.fromError(err, "Could not remove the plugin");
          }
        }}
      />
    </>
  );
}

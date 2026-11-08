import { useEffect, useState } from "react";
import { Boxes, Copy, Cpu, Download, HardDrive, Info, MemoryStick, RefreshCw, RotateCcw, ShieldCheck, Terminal, TriangleAlert } from "lucide-react";
import { Banner, Button, Input, Pill } from "./ui";
import { api, errorMessage } from "../lib/api";
import { useSession, useToast } from "../lib/app";
import { formatBytes } from "../lib/format";

/*
 * "Standalone ya Docker?" — the first real decision in the wizard.
 *
 * The two options are not cosmetic. Standalone starts the JVM directly, so memory/CPU limits are only
 * enforced when the host has cgroups v2 and the panel has the privileged helper. Docker puts the server
 * in its own cgroup, where `--memory` and `--cpus` are enforced by the kernel unconditionally — which is
 * the reason people ask for Docker in the first place.
 *
 * The card is honest about what Docker *cannot* do here: a per-container disk quota needs a storage
 * driver that supports it, and the panel asks the daemon instead of assuming.
 */

export type RuntimeChoice = "standalone" | "docker";

interface DockerEvidence {
  command: string;
  binary: string;
  exitCode: number;
  stderr: string;
  checkedAt: number;
}

interface DockerAccess {
  user: string;
  uid: number | null;
  elevated: boolean;
  platformLabel: string;
  groups: string[];
  endpoint: string;
  endpointSource: string;
  socketExists: boolean;
  socketMode: string | null;
  socketGroup: string | null;
  groupMissing: boolean;
  alternatives: string[];
  inContainer: boolean;
  environment: {
    platform: string;
    path: string;
    home: string | null;
    dockerHost: string | null;
    dockerContext: string | null;
    binEnv: string | null;
    cliContext: string | null;
  };
  binaries: { path: string; exists: boolean }[];
  evidence: DockerEvidence | null;
  hints: string[];
}

interface DockerInfo {
  available: boolean;
  version: string | null;
  storageDriver: string | null;
  cgroupVersion: string | null;
  diskQuota: boolean;
  reason: string | null;
  access?: DockerAccess | null;
}

interface DockerConfig {
  host: string | null;
  bin: string | null;
}

interface JavaImage {
  major: number;
  reference: string;
  source: "yolks" | "temurin";
  label: string;
  present: boolean;
}

interface AppImageInfo {
  family: "python" | "node";
  version: string;
  reference: string;
  source: "yolks" | "official";
  label: string;
}

export function RuntimePicker({
  value, onChange, image, onImage, javaMajor, memoryMb, cpuPercent, diskMb, app,
}: {
  value: RuntimeChoice;
  onChange: (runtime: RuntimeChoice) => void;
  image: string;
  onImage: (reference: string) => void;
  javaMajor: number;
  memoryMb: number;
  cpuPercent: number;
  diskMb: number;
  /**
   * Set for Python/Node servers. Docker images for those runtimes are not a Java-major choice: the
   * panel resolves one image per version (yolks when the tag exists, the official image otherwise)
   * and shows it here instead of the Java grid.
   */
  app?: { family: "python" | "node"; version: string } | null;
}) {
  const toast = useToast();
  const { can } = useSession();
  const canManage = can("system.manage");
  const [docker, setDocker] = useState<DockerInfo | null>(null);
  const [config, setConfig] = useState<DockerConfig>({ host: null, bin: null });
  const [images, setImages] = useState<JavaImage[]>([]);
  const [appImage, setAppImage] = useState<AppImageInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [pulling, setPulling] = useState(false);
  const [pullNote, setPullNote] = useState<string | null>(null);
  const [endpointDraft, setEndpointDraft] = useState("");
  const [savingEndpoint, setSavingEndpoint] = useState(false);
  const [endpointNote, setEndpointNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const result = await api.get<{ docker: DockerInfo; config?: DockerConfig }>("/api/panel/docker");
      setDocker(result.docker);
      if (result.config) setConfig(result.config);
      if (result.docker.available && !app) {
        const list = await api.get<{ majors: JavaImage[] }>("/api/panel/docker/images");
        setImages(list.majors);
      }
    } catch (caught) {
      setDocker({
        available: false, version: null, storageDriver: null, cgroupVersion: null, diskQuota: false,
        reason: errorMessage(caught),
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  /*
   * The image for a Python/Node version. Asked from the panel rather than guessed here, because
   * whether `yolks:python_3.12` exists is a registry fact, and the answer decides the reference.
   */
  useEffect(() => {
    if (!app) { setAppImage(null); return; }
    api.get<{ data: (AppImageInfo | null)[] }>(`/api/apps/images?versions=${app.family}:${app.version}`)
      .then((result) => {
        const found = (result.data ?? []).find(Boolean) ?? null;
        setAppImage(found);
        if (found && found.reference !== image) onImage(found.reference);
      })
      .catch(() => setAppImage(null));
  }, [app?.family, app?.version]);

  // When the software step changes the required Java major, keep the image in step with it.
  useEffect(() => {
    if (app) return;
    if (value !== "docker" || !javaMajor) return;
    const match = images.find((entry) => entry.major === Number(javaMajor));
    if (match && match.reference !== image) onImage(match.reference);
  }, [javaMajor, images, value, app]);

  const selected = images.find((entry) => entry.reference === image) ?? null;
  const dockerBlocked = docker !== null && !docker.available;

  /* Pre-fill the fix field with whatever is in force, so "Test" without editing re-probes it. */
  useEffect(() => {
    if (!endpointDraft && docker?.access?.endpoint) setEndpointDraft(docker.access.endpoint);
  }, [docker?.access?.endpoint]);

  const saveEndpoint = async (value: string) => {
    setSavingEndpoint(true);
    setEndpointNote(null);
    try {
      const result = await api.post<{ docker: DockerInfo; config: DockerConfig }>("/api/panel/docker/config", { host: value });
      setDocker(result.docker);
      setConfig(result.config);
      toast.success("Docker endpoint saved", `${value} reached the daemon.`);
      await load();
    } catch (caught) {
      setEndpointNote(errorMessage(caught));
    } finally {
      setSavingEndpoint(false);
    }
  };

  const resetEndpoint = async () => {
    setSavingEndpoint(true);
    setEndpointNote(null);
    try {
      const result = await api.delete<{ docker: DockerInfo; config: DockerConfig }>("/api/panel/docker/config");
      setDocker(result.docker);
      setConfig(result.config);
      setEndpointDraft(result.docker.access?.endpoint ?? "");
      toast.success("Endpoint override cleared", "The panel is back on the environment or default socket.");
    } catch (caught) {
      setEndpointNote(errorMessage(caught));
    } finally {
      setSavingEndpoint(false);
    }
  };

  const copyEvidence = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const prepare = async () => {
    setPulling(true);
    setPullNote(null);
    try {
      const result = await api.post<{ reference: string }>("/api/panel/docker/pull", { reference: image });
      toast.success("Image ready", `${result.reference} is on this machine.`);
      await load();
    } catch (caught) {
      setPullNote(errorMessage(caught));
    } finally {
      setPulling(false);
    }
  };

  return (
    <div className="stack">
      <div className="runtime-grid">
        <button
          type="button"
          className={`runtime-card ${value === "standalone" ? "selected" : ""}`}
          onClick={() => onChange("standalone")}
          aria-pressed={value === "standalone"}
        >
          <span className="runtime-icon"><Cpu size={18} /></span>
          <span className="runtime-body">
            <span className="runtime-title">
              Standalone
              <Pill tone="neutral">Default</Pill>
            </span>
            <span className="runtime-text">
              The JVM runs directly on this machine, started and watched by the panel. Fewer moving parts and
              no Docker requirement — but memory and CPU caps only bind where the host enforces cgroups.
            </span>
            <span className="runtime-facts">
              <span><MemoryStick size={11} /> Heap sized from the allocation</span>
              <span><ShieldCheck size={11} /> Limits: as strong as the host's cgroups</span>
            </span>
          </span>
        </button>

        <button
          type="button"
          className={`runtime-card ${value === "docker" ? "selected" : ""} ${dockerBlocked ? "disabled" : ""}`}
          onClick={() => { if (!dockerBlocked) onChange("docker"); }}
          aria-pressed={value === "docker"}
          aria-disabled={dockerBlocked}
        >
          <span className="runtime-icon"><Boxes size={18} /></span>
          <span className="runtime-body">
            <span className="runtime-title">
              Docker container
              {docker?.available ? (
                <Pill tone="green">Docker {docker.version}</Pill>
              ) : loading ? (
                <Pill tone="neutral">checking…</Pill>
              ) : (
                <Pill tone="red">not available</Pill>
              )}
            </span>
            <span className="runtime-text">
              The server runs in its own container with the same files bind-mounted at <span className="mono">/data</span>.
              Memory and CPU become hard limits enforced by that container's cgroup, and the panel reports usage from
              Docker itself.
            </span>
            <span className="runtime-facts">
              <span><MemoryStick size={11} /> {memoryMb} MB hard cap</span>
              <span><ShieldCheck size={11} /> {(Math.max(10, cpuPercent) / 100).toFixed(2)} CPU cores</span>
              <span><HardDrive size={11} /> {formatBytes(diskMb * 1024 * 1024)} {docker?.diskQuota ? "quota" : "target"}</span>
            </span>
          </span>
        </button>
      </div>

      {dockerBlocked ? (
        <div className="docker-diag">
          <Banner
            tone="warning"
            title={docker?.access && docker.access.binaries.some((entry) => entry.exists === false) && !docker.access.evidence
              ? "The panel cannot execute a Docker command"
              : "Docker is installed, but the panel cannot reach its daemon"}
          >
            {docker?.access?.hints?.[0] ?? docker?.reason}
          </Banner>
          {/*
            The facts, not just the error text. "Docker works in my shell but not in the panel" is a
            disagreement between two processes, so the panel shows its own side of it: which account and
            namespace it is in, which endpoint it used and why, and what the CLI printed when it tried.
            A panel that is already root is called out explicitly, because group advice is useless there.
          */}
          {docker?.access ? (
            <div className="info-list docker-facts">
              <div className="info-row">
                <span className="k">Panel account</span>
                <span className="v mono">
                  {docker.access.user}
                  {docker.access.uid !== null ? ` (uid ${docker.access.uid})` : ""}
                  {docker.access.elevated ? " · privileged" : ""}
                </span>
              </div>
              {docker.access.elevated ? null : (
                <div className="info-row">
                  <span className="k">Its groups</span>
                  <span className="v mono">{docker.access.groups.join(", ") || "—"}</span>
                </div>
              )}
              <div className="info-row">
                <span className="k">Endpoint</span>
                <span className="v mono">
                  {docker.access.endpoint}
                  <span className="docker-source"> from {docker.access.endpointSource}</span>
                </span>
              </div>
              <div className="info-row">
                <span className="k">Socket</span>
                <span className="v mono">
                  {docker.access.socketExists
                    ? `${docker.access.socketMode ?? ""}${docker.access.socketGroup ? ` · group ${docker.access.socketGroup}` : ""}`
                    : "not found at that path"}
                </span>
              </div>
              {docker.access.groupMissing ? (
                <div className="info-row">
                  <span className="k">Missing</span>
                  <span className="v">the <span className="mono">{docker.access.socketGroup}</span> group on this account</span>
                </div>
              ) : null}
              <div className="info-row">
                <span className="k">Namespace</span>
                <span className="v">
                  {docker.access.inContainer ? "inside a container" : "the host itself"}
                  {docker.access.environment.cliContext ? ` · CLI context “${docker.access.environment.cliContext}”` : ""}
                </span>
              </div>
              {docker.access.environment.dockerHost || docker.access.environment.dockerContext || docker.access.environment.binEnv ? (
                <div className="info-row">
                  <span className="k">Inherited env</span>
                  <span className="v mono">
                    {[
                      docker.access.environment.dockerHost ? `DOCKER_HOST=${docker.access.environment.dockerHost}` : null,
                      docker.access.environment.dockerContext ? `DOCKER_CONTEXT=${docker.access.environment.dockerContext}` : null,
                      docker.access.environment.binEnv ? `RSLMC_DOCKER_BIN=${docker.access.environment.binEnv}` : null,
                    ].filter(Boolean).join(" · ")}
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* The command and its raw output. Untranslated on purpose: this is the evidence. */}
          {docker?.access?.evidence ? (
            <div className="docker-evidence">
              <div className="docker-evidence-head">
                <Terminal size={12} />
                <span className="mono">{docker.access.evidence.command}</span>
                <span className="spacer" />
                <Pill tone={docker.access.evidence.exitCode === 0 ? "amber" : "red"}>
                  exit {docker.access.evidence.exitCode}
                </Pill>
                <Button variant="ghost" icon={<Copy size={11} />} onClick={() => void copyEvidence(docker.access!.evidence!.command)}>
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              {docker.access.evidence.stderr ? (
                <pre className="docker-evidence-out">{docker.access.evidence.stderr}</pre>
              ) : null}
            </div>
          ) : null}

          <div className="docker-fixes">
            {(docker?.access?.hints ?? (docker?.reason ? [docker.reason] : [])).map((hint, index) => (
              <div className="runtime-note" key={hint}>
                <span className="docker-fix-index">{index + 1}</span>
                <span>
                  {hint.split(/(`[^`]+`|— |RSLMC_[A-Z_]+=[^ ]+)/).map((part, partIndex) => (
                    part.startsWith("`") || part.startsWith("RSLMC_")
                      ? <span className="mono" key={partIndex}>{part.replace(/`/g, "")}</span>
                      : <span key={partIndex}>{part}</span>
                  ))}
                </span>
              </div>
            ))}
          </div>

          {/*
            The fix itself, not just instructions. Testing the endpoint from the panel is the difference
            between "compare your shell with mine" and a working Docker card 5 seconds later, and a value
            is only stored when the daemon actually answers through it.
          */}
          {canManage ? (
            <div className="docker-endpoint">
              <div className="docker-endpoint-head">
                <span className="text-xs faint">Docker endpoint</span>
                {config.host ? <Pill tone="blue">override saved</Pill> : null}
              </div>
              <div className="row" style={{ gap: 8 }}>
                <Input
                  value={endpointDraft}
                  onChange={(event) => setEndpointDraft(event.target.value)}
                  placeholder="unix:///var/run/docker.sock · tcp://host:2376 · context name"
                  spellCheck={false}
                  aria-label="Docker endpoint"
                />
                <Button
                  loading={savingEndpoint}
                  className="shrink-0"
                  onClick={() => void saveEndpoint(endpointDraft.trim())}
                  disabled={!endpointDraft.trim()}
                >
                  Test &amp; save
                </Button>
                {config.host ? (
                  <Button variant="ghost" icon={<RotateCcw size={12} />} onClick={() => void resetEndpoint()} disabled={savingEndpoint}>
                    Reset
                  </Button>
                ) : null}
              </div>
              <span className="text-xs faint">
                Saved only if the daemon answers through it. Stored in the panel's database, so it survives
                restarts and needs no <span className="mono">.env</span> edit.
              </span>
              {endpointNote ? <Banner tone="error" title="Not saved">{endpointNote}</Banner> : null}
            </div>
          ) : null}

          <div className="row" style={{ gap: 8 }}>
            <Button icon={<RefreshCw size={12} />} onClick={() => void load()} disabled={loading}>
              Check again
            </Button>
            <span className="text-xs faint">
              The standalone option keeps working; a server can be moved to Docker later without recreating it.
            </span>
          </div>
        </div>
      ) : null}

      {value === "docker" && docker?.available ? (
        <>
          <div className="runtime-image-head">
            <span className="text-xs faint">
              {app
                ? `${app.family === "python" ? "Python" : "Node.js"} ${app.version} · ${appImage ? appImage.label : "resolving image…"}`
                : <>Java {javaMajor} · {selected?.source === "yolks" ? "Pterodactyl yolks image" : "Eclipse Temurin image"}</>}
            </span>
            <span className="spacer" />
            <Button variant="ghost" icon={<RefreshCw size={12} />} onClick={() => void load()} disabled={loading || pulling}>
              Refresh
            </Button>
            {selected && !selected.present ? (
              <Button icon={<Download size={12} />} loading={pulling} onClick={() => void prepare()}>
                Prepare image
              </Button>
            ) : (
              <Pill tone="green">already pulled</Pill>
            )}
          </div>

          {app ? (
            <div className="runtime-images">
              {appImage ? (
                <button
                  type="button"
                  className="runtime-image selected"
                  onClick={() => onImage(appImage.reference)}
                  title={appImage.reference}
                >
                  <span className="mono">{app.family === "python" ? "Python" : "Node"} {app.version}</span>
                  <span className="faint text-xs">{appImage.source === "yolks" ? "yolks" : "official"}</span>
                </button>
              ) : (
                <span className="text-xs faint">Resolving the image for this version…</span>
              )}
            </div>
          ) : (
          <div className="runtime-images">
            {images.map((entry) => (
              <button
                key={entry.reference}
                type="button"
                className={`runtime-image ${entry.reference === image ? "selected" : ""}`}
                onClick={() => onImage(entry.reference)}
                title={entry.reference}
              >
                <span className="mono">Java {entry.major}</span>
                <span className="faint text-xs">{entry.source === "yolks" ? "yolks" : "temurin"}</span>
                {entry.present ? <span className="runtime-dot" title="Already on this machine" /> : null}
              </button>
            ))}
          </div>
          )}

          <div className="runtime-note">
            <Info size={12} />
            <span>
              Image: <span className="mono">{app ? (appImage?.reference ?? image) : image}</span>
              {app
                ? (appImage?.source === "yolks"
                    ? " — the Pterodactyl yolks image for this runtime line, the same family of images Minecraft servers use."
                    : " — Pterodactyl yolks has no tag for this runtime line, so the official image is used. The panel says so rather than pretending otherwise.")
                : selected?.source === "yolks"
                  ? " — built by Pterodactyl for Minecraft servers, one tag per Java major."
                  : " — the registry did not list a yolks tag for this major, so the same Temurin JDK is pulled directly."}
              {" "}The first start pulls it (≈ 200–400 MB) and shows progress in the console.
            </span>
          </div>

          {docker?.diskQuota ? (
            <div className="runtime-note">
              <HardDrive size={12} />
              <span>
                Disk: the daemon accepts a per-container size on the <span className="mono">{docker.storageDriver}</span> driver,
                so the {formatBytes(diskMb * 1024 * 1024)} disk target is enforced.
              </span>
            </div>
          ) : (
            <div className="runtime-note warn">
              <TriangleAlert size={12} />
              <span>
                Disk: this daemon uses the <span className="mono">{docker?.storageDriver ?? "unknown"}</span> storage driver,
                which cannot cap one container's size. Disk usage is measured and reported, the
                {" "}{formatBytes(diskMb * 1024 * 1024)} figure is a target — memory and CPU are still hard limits.
              </span>
            </div>
          )}
          {pullNote ? <Banner tone="error" title="Image not prepared">{pullNote}</Banner> : null}
        </>
      ) : null}
    </div>
  );
}

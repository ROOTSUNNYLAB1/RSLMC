import { useEffect, useState } from "react";
import { Boxes, Cpu, Download, HardDrive, Info, MemoryStick, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { Banner, Button, Pill } from "./ui";
import { api, errorMessage } from "../lib/api";
import { useToast } from "../lib/app";
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

interface DockerInfo {
  available: boolean;
  version: string | null;
  storageDriver: string | null;
  cgroupVersion: string | null;
  diskQuota: boolean;
  reason: string | null;
}

interface JavaImage {
  major: number;
  reference: string;
  source: "yolks" | "temurin";
  label: string;
  present: boolean;
}

export function RuntimePicker({
  value, onChange, image, onImage, javaMajor, memoryMb, cpuPercent, diskMb,
}: {
  value: RuntimeChoice;
  onChange: (runtime: RuntimeChoice) => void;
  image: string;
  onImage: (reference: string) => void;
  javaMajor: number;
  memoryMb: number;
  cpuPercent: number;
  diskMb: number;
}) {
  const toast = useToast();
  const [docker, setDocker] = useState<DockerInfo | null>(null);
  const [images, setImages] = useState<JavaImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [pulling, setPulling] = useState(false);
  const [pullNote, setPullNote] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const result = await api.get<{ docker: DockerInfo }>("/api/panel/docker");
      setDocker(result.docker);
      if (result.docker.available) {
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

  // When the software step changes the required Java major, keep the image in step with it.
  useEffect(() => {
    if (value !== "docker" || !javaMajor) return;
    const match = images.find((entry) => entry.major === Number(javaMajor));
    if (match && match.reference !== image) onImage(match.reference);
  }, [javaMajor, images, value]);

  const selected = images.find((entry) => entry.reference === image) ?? null;
  const dockerBlocked = docker !== null && !docker.available;

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
        <Banner tone="warning" title="Docker is not usable on this machine">
          {docker?.reason}
          {" "}The standalone option keeps working; container servers can be enabled later without recreating anything.
        </Banner>
      ) : null}

      {value === "docker" && docker?.available ? (
        <>
          <div className="runtime-image-head">
            <span className="text-xs faint">
              Java {javaMajor} · {selected?.source === "yolks" ? "Pterodactyl yolks image" : "Eclipse Temurin image"}
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

          <div className="runtime-note">
            <Info size={12} />
            <span>
              Image: <span className="mono">{image}</span>
              {selected?.source === "yolks"
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

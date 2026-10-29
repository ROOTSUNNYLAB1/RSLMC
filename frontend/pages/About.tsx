import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight, BadgeCheck, CheckCircle2, CircleDashed, CircleSlash, Cloud, Cpu, Database, Download,
  ExternalLink, FolderTree, GitBranch, Code2, HardDrive, Info, Loader2, Package, Power, RefreshCw,
  Rocket, Server, ShieldCheck, Sparkles, Star, Terminal, TriangleAlert, Users, XCircle, Clock,
} from "lucide-react";
import {
  Banner, Button, Card, CopyValue, Field, InfoList, Loading, Modal, PageHeader, Pill, ProgressBar,
  Select, Toggle,
} from "../components/ui";
import { api } from "../lib/api";
import { useSession, useToast } from "../lib/app";
import { Link } from "../lib/router";
import { formatBytes, formatDateTime, formatDuration, relativeTime } from "../lib/format";

/*
 * Administration → About.
 *
 * Everything an operator wants to know about the panel they are running, in one place: the exact
 * build (CalVer), where it keeps its data, what it is doing to the host, and — the reason this page
 * exists — whether a newer release is out, what is in it, and one button to install it and one to
 * restart the panel into it. Nothing on this page is decorative: every number is measured, every
 * action is a real API call, and a failed step says so instead of spinning forever.
 */

type UpdateJob = {
  id: number;
  targetVersion: string;
  status: "running" | "success" | "failed";
  stage: string;
  steps: { id: string; label: string; status: "pending" | "running" | "done" | "failed" | "skipped"; detail?: string; startedAt?: number; finishedAt?: number }[];
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  actorName: string | null;
};

type About = {
  version: string;
  build: {
    mode: string; port: number; bun: string; platform: string; arch: string; pid: number;
    uptimeSeconds: number; startedAt: string; routes: number; cpuCores: number; memoryTotalBytes: number;
  };
  paths: { root: string; data: string; dataSource: string; dataNote: string | null; database: string; backups: string };
  enforcement: { memory: { level: string; mechanism: string }; cpu: { level: string; mechanism: string }; disk: { level: string; mechanism: string } };
  disk: { usedBytes: number; freeBytes: number; totalBytes: number };
  update: {
    currentVersion: string; currentIsCalVer: boolean; latest: any; updateAvailable: boolean; dismissed: boolean;
    pendingRestartVersion: string | null; lastCheckedAt: string | null; lastCheckError: string | null;
    checking: boolean; installing: boolean; source: string; canManage: boolean;
    settings: { autoCheck: boolean; includePrerelease: boolean; intervalMinutes: number; repository: string };
    job: UpdateJob | null; history: UpdateJob[];
  };
  restart: {
    current: { phase: string; requestedAt: number; reason: string; actor: string | null; serversKept?: number } | null;
    inProgress: boolean; pid: number; startedAt: number; canManage: boolean;
    history: { id: number; kind: string; reason: string; actorName: string | null; requestedAt: string; completedAt: string | null; bootMs: number | null; serversKept: number; fromVersion: string; toVersion: string }[];
  };
  repository: {
    slug: string; url: string;
    info: { stars: number; forks: number; openIssues: number; license: string | null; topics: string[]; pushedAt: string | null; description: string | null } | null;
    error: string | null;
    releases: { version: string; name: string; url: string; publishedAt: string | null; prerelease: boolean; age: string | null; notes: string; isCurrent: boolean; isNewer: boolean }[];
  };
  credits: { license: string; stack: { name: string; role: string }[]; acknowledgements: string[] };
};

const STEP_ICON = {
  pending: <CircleDashed size={13} />,
  running: <Loader2 size={13} className="spin" />,
  done: <CheckCircle2 size={13} />,
  failed: <XCircle size={13} />,
  skipped: <CircleSlash size={13} />,
} as const;

/** Minimal, safe markdown → React: headings, bullets and inline code. No HTML is ever injected. */
function ReleaseNotes({ text }: { text: string }) {
  const blocks = useMemo(() => {
    const lines = text.replace(/\r/g, "").split("\n");
    const out: { kind: "h" | "li" | "p" | "code"; text: string }[] = [];
    let code: string[] | null = null;
    for (const raw of lines) {
      if (raw.trim().startsWith("```")) {
        if (code) { out.push({ kind: "code", text: code.join("\n") }); code = null; }
        else code = [];
        continue;
      }
      if (code) { code.push(raw); continue; }
      const line = raw.trim();
      if (!line) continue;
      if (/^#{1,4}\s/.test(line)) out.push({ kind: "h", text: line.replace(/^#{1,4}\s*/, "").replace(/\*\*/g, "") });
      else if (/^[-*]\s/.test(line)) out.push({ kind: "li", text: line.replace(/^[-*]\s*/, "") });
      else out.push({ kind: "p", text: line });
    }
    if (code) out.push({ kind: "code", text: code.join("\n") });
    return out.slice(0, 160);
  }, [text]);

  const inline = (value: string) => {
    const parts = value.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean);
    return parts.map((part, index) => {
      if (part.startsWith("`") && part.endsWith("`")) return <code key={index} className="about-code">{part.slice(1, -1)}</code>;
      if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
      return <span key={index}>{part}</span>;
    });
  };

  if (!text.trim()) {
    return <p className="about-note">This release does not have notes.</p>;
  }
  return (
    <div className="about-notes">
      {blocks.map((block, index) => {
        if (block.kind === "h") return <h4 key={index}>{inline(block.text)}</h4>;
        if (block.kind === "li") return <div className="about-note-li" key={index}><span className="dot" />{inline(block.text)}</div>;
        if (block.kind === "code") return <pre key={index} className="about-pre">{block.text}</pre>;
        return <p key={index}>{inline(block.text)}</p>;
      })}
    </div>
  );
}

export function AboutPage() {
  const [data, setData] = useState<About | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartPhase, setRestartPhase] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const toast = useToast();
  const { refresh } = useSession();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const payload = await api.get<About>("/api/panel/about");
      setData(payload);
      setLoadError(null);
      return payload;
    } catch (error: any) {
      setLoadError(error?.message ?? "Could not load the panel details");
      return null;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // While an install is running, follow its steps closely; otherwise refresh gently.
  useEffect(() => {
    const interval = setInterval(() => { void load(); }, data?.update.installing ? 900 : 6000);
    return () => clearInterval(interval);
  }, [load, data?.update.installing]);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const job = data?.update.job ?? null;
  const installRunning = job?.status === "running" || Boolean(data?.update.installing);
  const pendingRestart = data?.update.pendingRestartVersion ?? null;
  const latest = data?.update.latest ?? null;

  const checkNow = async () => {
    setChecking(true);
    try {
      await api.post("/api/panel/update/check");
      const payload = await load();
      if (payload?.update.latest && payload.update.updateAvailable) {
        toast.success(`RSLMC ${payload.update.latest.version} is available`);
      } else if (payload?.update.lastCheckError) {
        toast.error(payload.update.lastCheckError);
      } else {
        toast.info(`You are on the newest release (${data?.version ?? ""})`);
      }
    } catch (error: any) {
      toast.error(error?.message ?? "The update check failed");
    } finally {
      setChecking(false);
    }
  };

  const installNow = async () => {
    setStarting(true);
    try {
      await api.post("/api/panel/update/install");
      toast.info(`Installing ${latest?.version ?? "the update"}…`);
      await load();
    } catch (error: any) {
      toast.error(error?.message ?? "The update could not be started");
    } finally {
      setStarting(false);
    }
  };

  const restartPanel = async () => {
    setConfirmRestart(false);
    setRestarting(true);
    setRestartPhase("requested");
    try {
      await api.post("/api/panel/restart", { acknowledge: true, reason: pendingRestart ? `Applying RSLMC ${pendingRestart}` : "Restart requested from Administration → About" });
    } catch (error: any) {
      setRestarting(false);
      setRestartPhase(null);
      toast.error(error?.message ?? "The panel did not restart");
      return;
    }
    // Follow the bounce: the panel disappears for a second, then answers again.
    let down = false;
    let attempts = 0;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      attempts += 1;
      try {
        const response = await fetch("/api/panel/about", { credentials: "same-origin", cache: "no-store" });
        if (!response.ok) throw new Error(String(response.status));
        const payload = await response.json() as About;
        if (down || attempts > 3) {
          setRestarting(false);
          setRestartPhase(null);
          if (pollRef.current) clearInterval(pollRef.current);
          setData(payload);
          await refresh();
          const completed = payload.restart.history[0];
          toast.success(
            completed?.bootMs
              ? `RSLMC is back in ${(completed.bootMs / 1000).toFixed(1)} s${completed.serversKept ? ` — ${completed.serversKept} server${completed.serversKept === 1 ? "" : "s"} never stopped` : ""}`
              : "RSLMC is back",
            );
        }
      } catch {
        down = true;
        setRestartPhase("waiting");
      }
      if (attempts > 120 && pollRef.current) {
        clearInterval(pollRef.current);
        setRestarting(false);
        setRestartPhase(null);
        toast.error("The panel did not come back. Check the restart log on the host.");
      }
    }, 700);
  };

  const saveSettings = async (patch: Record<string, unknown>) => {
    setSavingSettings(true);
    try {
      await api.patch("/api/panel/update/settings", patch);
      await load();
      toast.success("Update settings saved");
    } catch (error: any) {
      toast.error(error?.message ?? "Could not save the settings");
    } finally {
      setSavingSettings(false);
    }
  };

  const dismiss = async () => {
    try {
      await api.post("/api/panel/update/dismiss", { version: latest?.version });
      await load();
    } catch (error: any) {
      toast.error(error?.message ?? "Could not dismiss");
    }
  };

  if (!data) {
    return loadError
      ? <Banner tone="error" title="Administration → About is unavailable">{loadError}</Banner>
      : <Loading label="Reading the panel build information…" minHeight={320} />;
  }

  const canManage = data.update.canManage;
  const status = pendingRestart
    ? { tone: "amber" as const, label: "Restart required", text: `RSLMC ${pendingRestart} is installed and will run after a restart.` }
    : data.update.updateAvailable
      ? { tone: "blue" as const, label: "Update available", text: `RSLMC ${latest?.version} is available.` }
      : data.update.lastCheckError
        ? { tone: "neutral" as const, label: "Could not check", text: data.update.lastCheckError }
        : !latest && (data.update.checking || !data.update.lastCheckedAt)
          ? { tone: "neutral" as const, label: "Checking for releases", text: `Reading the release feed for ${data.update.settings.repository}. This finishes in a second.` }
          : !latest
            ? { tone: "neutral" as const, label: "Nothing published yet", text: `No release or tag was found for ${data.update.settings.repository}. The panel will pick up the first one automatically.` }
            : { tone: "green" as const, label: "Up to date", text: "You are running the newest published release." };

  return (
    <>
      <PageHeader
        title="About RSLMC"
        icon={<Info size={19} />}
        subtitle="Build details, the update channel, and the controls that install a new release and restart the panel."
        status={<Pill tone={status.tone} dot>{status.label}</Pill>}
        actions={
          <>
            <Button icon={<Code2 size={14} />} onClick={() => window.open(data.repository.url, "_blank", "noopener")}>
              Repository
            </Button>
            {canManage ? (
              <Button icon={<RefreshCw size={14} />} loading={checking || data.update.checking} onClick={checkNow}>
                Check for updates
              </Button>
            ) : null}
          </>
        }
      />

      {/* ------------------------------ Version hero ------------------------------ */}
      <section className="about-hero">
        <div className="about-hero-main">
          <div className="about-hero-top">
            <span className="about-wordmark">RSLMC</span>
            <Pill tone={status.tone} dot>{status.label}</Pill>
          </div>
          <div className="about-version-row">
            <div className="about-version">
              <span className="about-version-label">You are running</span>
              <span className="about-version-number">{data.version}</span>
              <span className="about-version-scheme">Calendar versioning · {data.update.currentIsCalVer === false ? "non-standard build" : "YYYY.MM.DD"}</span>
            </div>
            <div className="about-hero-arrow" aria-hidden>
              {latest && data.update.updateAvailable ? <><span className="from">{data.version}</span><Rocket size={16} /><span className="to">{latest.version}</span></> : <BadgeCheck size={18} color="var(--green)" />}
            </div>
          </div>
          <p className="about-hero-line">{status.text}</p>
          <div className="about-hero-actions">
            {pendingRestart && canManage ? (
              <Button variant="primary" icon={<Power size={14} />} onClick={() => setConfirmRestart(true)}>
                Restart RSLMC
              </Button>
            ) : null}
            {data.update.updateAvailable && canManage ? (
              <Button variant="success" icon={<Download size={14} />} loading={starting || installRunning} onClick={installNow} disabled={installRunning || Boolean(pendingRestart)}>
                {installRunning ? "Installing…" : `Install ${latest?.version}`}
              </Button>
            ) : null}
            {!pendingRestart && canManage ? (
              <Button icon={<Power size={14} />} onClick={() => setConfirmRestart(true)}>
                Restart RSLMC
              </Button>
            ) : null}
            {latest ? (
              <Button onClick={() => window.open(latest.url, "_blank", "noopener")} icon={<ArrowUpRight size={14} />}>
                Release notes on GitHub
              </Button>
            ) : null}
          </div>
          <div className="about-hero-meta">
            <span><Clock size={11} /> Last checked {data.update.lastCheckedAt ? relativeTime(data.update.lastCheckedAt) : "never"}</span>
            <span><GitBranch size={11} /> {data.update.settings.repository} · {data.update.source === "tags" ? "git tags" : "releases"}</span>
            {data.update.settings.includePrerelease ? <span><Sparkles size={11} /> pre-releases included</span> : null}
          </div>
        </div>

        <div className="about-hero-side">
          <div className="about-mini">
            <span className="k">Build</span>
            <span className="v mono">{data.build.bun}</span>
            <span className="s">Bun runtime</span>
          </div>
          <div className="about-mini">
            <span className="k">Uptime</span>
            <span className="v">{formatDuration(data.build.uptimeSeconds)}</span>
            <span className="s">pid {data.build.pid}</span>
          </div>
          <div className="about-mini">
            <span className="k">API routes</span>
            <span className="v">{data.build.routes}</span>
            <span className="s">{data.build.platform}/{data.build.arch}</span>
          </div>
          <div className="about-mini">
            <span className="k">Data</span>
            <span className="v">{data.paths.dataSource === "env" ? "custom" : "default"}</span>
            <span className="s">{formatBytes(data.disk.freeBytes)} free</span>
          </div>
        </div>
      </section>

      {data.update.lastCheckError && !data.update.updateAvailable ? (
        <Banner tone="warning" title="The last update check did not complete">
          {data.update.lastCheckError} Nothing else is affected — servers, files and users are untouched.
        </Banner>
      ) : null}

      {data.update.updateAvailable && latest && !data.update.dismissed ? (
        <Card
          title={`RSLMC ${latest.version} is available`}
          icon={<Sparkles size={12} />}
          actions={
            <div className="row gap-8">
              {latest.releaseAge ? <span className="text-xs muted">released {latest.releaseAge}</span> : null}
              {latest.prerelease ? <Pill tone="violet">pre-release</Pill> : null}
              {latest.verified ? <Pill tone="green">checksum published</Pill> : <Pill tone="neutral">no checksum</Pill>}
              {canManage ? <Button size="sm" onClick={dismiss}>Dismiss</Button> : null}
            </div>
          }
        >
          <div className="about-release">
            <div className="about-release-notes">
              <div className="about-section-label">What changed</div>
              <ReleaseNotes text={latest.notes} />
            </div>
            <div className="about-release-side">
              <InfoList rows={[
                { key: "Current", value: <span className="mono">{data.version}</span> },
                { key: "New", value: <span className="mono" style={{ color: "var(--green-text)" }}>{latest.version}</span> },
                { key: "Archive", value: <span className="mono text-xs">{latest.assetName ?? "source archive"}</span> },
                { key: "Published", value: latest.publishedAt ? formatDateTime(latest.publishedAt) : "—" },
                { key: "Data at risk", value: <span style={{ color: "var(--green-text)" }}>none — code only</span> },
              ]} />
              {canManage ? (
                <Button variant="success" icon={<Download size={14} />} onClick={installNow} loading={starting} disabled={installRunning || Boolean(pendingRestart)} style={{ width: "100%", marginTop: 10 }}>
                  Install update
                </Button>
              ) : (
                <p className="about-note">An administrator can install this update.</p>
              )}
            </div>
          </div>
        </Card>
      ) : null}

      {/* ------------------------------ Install progress ------------------------------ */}
      {job ? (
        <Card
          title={job.status === "running" ? `Installing RSLMC ${job.targetVersion}` : job.status === "success" ? `RSLMC ${job.targetVersion} is installed` : "The last update did not finish"}
          icon={job.status === "running" ? <Loader2 size={12} className="spin" /> : job.status === "success" ? <CheckCircle2 size={12} /> : <TriangleAlert size={12} />}
          actions={
            <span className="text-xs muted">
              {job.actorName ? `by ${job.actorName} · ` : ""}{relativeTime(job.startedAt)}
            </span>
          }
        >
          <div className="install-timeline">
            {job.steps.map((step) => (
              <div key={step.id} className={`install-step ${step.status}`}>
                <span className="install-step-icon">{STEP_ICON[step.status]}</span>
                <span className="install-step-label">{step.label}</span>
                <span className="install-step-detail">
                  {step.detail ?? (step.status === "running" ? "working…" : "")}
                </span>
              </div>
            ))}
          </div>
          {job.status === "running" ? (
            <div style={{ marginTop: 10 }}>
              <ProgressBar
                value={job.steps.filter((step) => step.status === "done" || step.status === "skipped").length}
                max={job.steps.length}
                tone="var(--green)"
              />
            </div>
          ) : null}
          {job.status === "failed" && job.error ? (
            <Banner tone="error" title="Update failed">{job.error}</Banner>
          ) : null}
          {job.status === "success" && pendingRestart ? (
            <Banner
              tone="warning"
              title="Almost there — restart to finish"
              action={canManage ? <Button variant="primary" size="sm" icon={<Power size={13} />} onClick={() => setConfirmRestart(true)}>Restart RSLMC</Button> : undefined}
            >
              The new files are on disk but the panel is still running {data.version}. A restart takes a few
              seconds and <strong>does not stop any server</strong>.
            </Banner>
          ) : null}
        </Card>
      ) : null}

      {/* ------------------------------ Restart ------------------------------ */}
      {pendingRestart ? (
        <Card title="Finish the update" icon={<Power size={12} />}>
          <div className="about-restart">
            <div>
              <div className="about-section-label">Waiting to start</div>
              <div className="about-restart-version">{pendingRestart}</div>
              <p className="about-note">
                Installed and verified. Restarting the panel swaps the running code for the new build.
                Every server keeps running: they are held by their own relay processes, and the panel
                reconnects to them after the bounce.
              </p>
            </div>
            <div className="about-restart-actions">
              {canManage ? (
                <Button variant="primary" icon={<Power size={14} />} onClick={() => setConfirmRestart(true)}>Restart RSLMC</Button>
              ) : <span className="about-note">An administrator can finish this.</span>}
            </div>
          </div>
        </Card>
      ) : null}

      <div className="grid grid-2">
        <Card title="Update channel" icon={<RefreshCw size={12} />}>
          <div className="about-settings">
            <Toggle
              checked={data.update.settings.autoCheck}
              disabled={!canManage || savingSettings}
              onChange={(value) => saveSettings({ autoCheck: value })}
              label="Check GitHub for new releases automatically"
            />
            <Toggle
              checked={data.update.settings.includePrerelease}
              disabled={!canManage || savingSettings}
              onChange={(value) => saveSettings({ includePrerelease: value })}
              label="Include pre-releases"
            />
            <Field label="Check every" hint="The panel polls the public GitHub API. No account or token is used.">
              <Select
                value={String(data.update.settings.intervalMinutes)}
                disabled={!canManage || savingSettings}
                onChange={(event) => saveSettings({ intervalMinutes: Number(event.target.value) })}
              >
                <option value="30">30 minutes</option>
                <option value="60">1 hour</option>
                <option value="180">3 hours</option>
                <option value="360">6 hours</option>
                <option value="720">12 hours</option>
                <option value="1440">24 hours</option>
              </Select>
            </Field>
            <InfoList rows={[
              { key: "Source", value: <a className="link" href={`${data.repository.url}/releases`} target="_blank" rel="noreferrer">{data.update.settings.repository}</a> },
              { key: "Last check", value: data.update.lastCheckedAt ? formatDateTime(data.update.lastCheckedAt) : "never" },
              { key: "Last error", value: data.update.lastCheckError ? <span style={{ color: "var(--amber-text)" }}>{data.update.lastCheckError}</span> : "none" },
            ]} />
          </div>
        </Card>

        <Card title="Restart history" icon={<Clock size={12} />} bodyClass="tight">
          {data.restart.history.length === 0 ? (
            <p className="about-note" style={{ padding: 12 }}>The panel has not been restarted through this page yet.</p>
          ) : (
            <table className="table">
              <thead><tr><th>When</th><th>Reason</th><th>By</th><th>Boot</th><th>Servers kept</th></tr></thead>
              <tbody>
                {data.restart.history.map((entry) => (
                  <tr key={entry.id}>
                    <td className="text-xs">{relativeTime(entry.requestedAt)}</td>
                    <td className="text-xs">{entry.reason || "—"}</td>
                    <td className="text-xs">{entry.actorName ?? "system"}</td>
                    <td className="mono text-xs">{entry.bootMs ? `${(entry.bootMs / 1000).toFixed(1)} s` : "—"}</td>
                    <td className="text-xs">{entry.serversKept > 0 ? <Pill tone="green">{entry.serversKept}</Pill> : <span className="muted">none</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {/* ------------------------------ Repository ------------------------------ */}
      <Card
        title="Project"
        icon={<Code2 size={12} />}
        actions={<a className="link text-xs" href={data.repository.url} target="_blank" rel="noreferrer">Open on GitHub <ExternalLink size={11} /></a>}
      >
        <div className="about-repo">
          <div className="about-repo-main">
            <p className="about-repo-desc">{data.repository.info?.description ?? "A self-hosted Minecraft server panel that shows you the truth — real processes, real metrics, no black boxes."}</p>
            <div className="about-repo-stats">
              <span><Star size={12} /> {data.repository.info?.stars ?? "—"} stars</span>
              <span><GitBranch size={12} /> {data.repository.info?.forks ?? "—"} forks</span>
              <span><Info size={12} /> {data.repository.info?.openIssues ?? "—"} issues</span>
              <span><ShieldCheck size={12} /> {data.repository.info?.license ?? data.credits.license} licence</span>
              <span><Users size={12} /> {data.repository.slug}</span>
            </div>
            {data.repository.info?.topics?.length ? (
              <div className="about-topics">
                {data.repository.info.topics.slice(0, 10).map((topic) => <span key={topic} className="about-topic">{topic}</span>)}
              </div>
            ) : null}
            {data.repository.error ? <p className="about-note muted">GitHub could not be reached for repository statistics: {data.repository.error}</p> : null}
          </div>
          <div className="about-repo-links">
            <a className="about-link" href={data.repository.url} target="_blank" rel="noreferrer"><Code2 size={13} /> Source code</a>
            <a className="about-link" href={`${data.repository.url}/releases`} target="_blank" rel="noreferrer"><Package size={13} /> Releases</a>
            <a className="about-link" href={`${data.repository.url}/issues`} target="_blank" rel="noreferrer"><Terminal size={13} /> Issues</a>
            <a className="about-link" href={`${data.repository.url}/blob/main/LICENSE`} target="_blank" rel="noreferrer"><ShieldCheck size={13} /> Licence</a>
            <a className="about-link" href={`${data.repository.url}/blob/main/docs/screenshots`} target="_blank" rel="noreferrer"><Sparkles size={13} /> Screenshots</a>
          </div>
        </div>

        {data.repository.releases.length === 0 ? (
          <p className="about-note muted" style={{ marginTop: 12 }}>
            {data.repository.error
              ? "GitHub could not be read, so recent releases are not shown."
              : "This repository has not published a GitHub release yet — the updater follows git tags until it does."}
          </p>
        ) : (
          <div className="about-releases">
            <div className="about-section-label">Recent releases</div>
            {data.repository.releases.map((release) => (
              <a key={release.version} className={`about-release-row ${release.isCurrent ? "current" : ""}`} href={release.url} target="_blank" rel="noreferrer">
                <span className="mono">{release.version}</span>
                {release.isCurrent ? <Pill tone="green">running</Pill> : release.isNewer ? <Pill tone="blue">newer</Pill> : <Pill tone="neutral">older</Pill>}
                {release.prerelease ? <Pill tone="violet">pre-release</Pill> : null}
                <span className="muted text-xs">{release.age ?? ""}</span>
                <ArrowUpRight size={12} />
              </a>
            ))}
          </div>
        )}
      </Card>

      {/* ------------------------------ Build & host ------------------------------ */}
      <div className="grid grid-2">
        <Card title="Build" icon={<Cpu size={12} />}>
          <InfoList rows={[
            { key: "Version", value: <span className="mono">{data.version}</span> },
            { key: "Scheme", value: "CalVer (YYYY.MM.DD)" },
            { key: "Bun", value: <span className="mono">{data.build.bun}</span> },
            { key: "Mode", value: data.build.mode },
            { key: "Platform", value: <span className="mono">{data.build.platform} · {data.build.arch} · {data.build.cpuCores} cores</span> },
            { key: "Listening", value: <span className="mono">:{data.build.port}</span> },
            { key: "Process", value: <span className="mono">pid {data.build.pid}</span> },
            { key: "Started", value: `${formatDateTime(data.build.startedAt)} (${formatDuration(data.build.uptimeSeconds)} ago)` },
            { key: "API routes", value: data.build.routes },
          ]} />
        </Card>

        <Card title="Where everything lives" icon={<FolderTree size={12} />}>
          <InfoList rows={[
            { key: "Code", value: <CopyValue value={data.paths.root} mono /> },
            { key: "Data", value: <CopyValue value={data.paths.data} mono /> },
            { key: "Data source", value: data.paths.dataSource },
            { key: "Database", value: <CopyValue value={data.paths.database} mono /> },
            { key: "Backups", value: <CopyValue value={data.paths.backups} mono /> },
            { key: "Disk", value: `${formatBytes(data.disk.usedBytes)} used · ${formatBytes(data.disk.freeBytes)} free of ${formatBytes(data.disk.totalBytes)}` },
            {
              key: "Enforcement",
              value: (
                <span className="row gap-8" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
                  <Pill tone={data.enforcement?.memory?.level === "enforced" ? "green" : "amber"}>memory {data.enforcement?.memory?.level ?? "unknown"}</Pill>
                  <Pill tone={data.enforcement?.cpu?.level === "enforced" ? "green" : "amber"}>cpu {data.enforcement?.cpu?.level ?? "unknown"}</Pill>
                  <Pill tone={data.enforcement?.disk?.level === "enforced" ? "green" : "amber"}>disk {data.enforcement?.disk?.level ?? "unknown"}</Pill>
                </span>
              ),
            },
          ]} />
          {data.paths.dataNote ? <p className="about-note muted" style={{ marginTop: 10 }}>{data.paths.dataNote}</p> : null}
        </Card>
      </div>

      {/* ------------------------------ Credits ------------------------------ */}
      <Card title="Built with" icon={<Database size={12} />}>
        <div className="about-stack">
          {data.credits.stack.map((item) => (
            <div key={item.name} className="about-stack-item">
              <span className="name">{item.name}</span>
              <span className="role">{item.role}</span>
            </div>
          ))}
        </div>
        <div className="about-section-label" style={{ marginTop: 14 }}>Thanks</div>
        <ul className="about-thanks">
          {data.credits.acknowledgements.map((line) => <li key={line}>{line}</li>)}
        </ul>
        <p className="about-note" style={{ marginTop: 10 }}>
          RSLMC is released under the {data.credits.license} licence. It is an independent project — not
          affiliated with Mojang, Microsoft or Pterodactyl. Minecraft is a trademark of Mojang Synergies AB.
        </p>
      </Card>

      {/* ------------------------------ Restart overlay ------------------------------ */}
      <Modal
        open={restarting}
        onClose={() => { /* not closable while the panel is bouncing */ }}
        title="Restarting RSLMC"
        size="narrow"
        footer={null}
      >
        <div className="restart-overlay">
          <div className="restart-spinner"><Loader2 size={18} className="spin" /></div>
          <div>
            <div className="restart-title">
              {restartPhase === "waiting" ? "Waiting for the panel to come back…" : "Handing over…"}
            </div>
            <p className="about-note">
              Servers keep running. This window reconnects on its own — no need to reload.
            </p>
          </div>
        </div>
      </Modal>

      <Modal
        open={confirmRestart}
        onClose={() => setConfirmRestart(false)}
        title="Restart RSLMC?"
        size="narrow"
        icon={<Power size={16} color="var(--blue)" />}
        footer={
          <>
            <Button onClick={() => setConfirmRestart(false)}>Cancel</Button>
            <Button variant="primary" icon={<Power size={14} />} onClick={restartPanel}>Restart now</Button>
          </>
        }
      >
        <div style={{ fontSize: 12.5, lineHeight: 1.7, color: "var(--text-dim)" }}>
          <p style={{ marginTop: 0 }}>The panel process stops and starts again with the same data folder and port. Expect a few seconds of downtime for the web interface.</p>
          <ul style={{ margin: "8px 0 0 16px", padding: 0 }}>
            <li><strong style={{ color: "var(--green-text)" }}>Minecraft servers keep running</strong> — they are held by their own relay processes and are reattached automatically.</li>
            <li>Every open panel session is interrupted; you stay signed in.</li>
            <li>Scheduled tasks resume when the panel is back.</li>
            {pendingRestart ? <li>The new build <strong>{pendingRestart}</strong> starts running.</li> : null}
          </ul>
          {data.restart.inProgress ? <p style={{ color: "var(--amber-text)" }}>A restart is already in progress.</p> : null}
        </div>
      </Modal>
    </>
  );
}

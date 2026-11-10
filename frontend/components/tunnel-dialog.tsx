import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Cloud, Copy, DownloadCloud, Play, RotateCw, Square, Trash2, UploadCloud } from "lucide-react";
import { Banner, Button, CopyValue, Field, Input, Modal, Pill, Select } from "./ui";
import { api } from "../lib/api";
import { useSession, useToast } from "../lib/app";

/*
 * Cloudflare Tunnel, for a node.
 *
 * This is the panel's answer to "my node has no public IP, or I do not want to open a port". Cloudflare
 * Tunnel is the one route that needs nothing inbound on the node: `cloudflared` dials out, Cloudflare
 * serves the hostname, and the controller talks to that hostname like any other address.
 *
 * Two modes are offered, and the difference is stated rather than hidden:
 *   • **Your own domain** — create the tunnel in Cloudflare Zero Trust, point a public hostname at
 *     `http://127.0.0.1:<panel port>`, paste the token here. The hostname is stable and yours.
 *   • **Temporary hostname** — no account, no DNS. Cloudflare assigns `<random>.trycloudflare.com`.
 *     Perfect for proving the path works; wrong for anything you intend to keep, because the name
 *     changes every start.
 */

interface TunnelSnapshot {
  nodeId: number;
  configured: boolean;
  mode: "token" | "quick";
  hostname: string | null;
  status: "stopped" | "starting" | "running" | "failed";
  hasToken: boolean;
  tokenFingerprint: string | null;
  localUrl: string;
  enabled: boolean;
  lastError: string | null;
  lastStartedAt: string | null;
  publicUrl: string | null;
  cloudflared: {
    path: string | null; version: string | null; source: string; problem: string | null;
    sizeBytes: number | null; installPath: string; installable: boolean;
  };
  log: string[];
}

interface CheckResult { hostname: string; reachable: boolean; status: number | null; latencyMs: number | null; detail: string }

export function TunnelDialog({ node, open, onClose, onChanged }: {
  node: { id: number; name: string; isLocal: boolean; port: number };
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const { can } = useSession();
  const [tunnel, setTunnel] = useState<TunnelSnapshot | null>(null);
  const [limits, setLimits] = useState<string[]>([]);
  const [mode, setMode] = useState<"token" | "quick">("token");
  const [hostname, setHostname] = useState("");
  const [token, setToken] = useState("");
  const [localPort, setLocalPort] = useState(String(node.port));
  const [busy, setBusy] = useState<string | null>(null);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [unreachable, setUnreachable] = useState<string | null>(null);
  const [cached, setCached] = useState<{ hostname: string | null; mode: string | null; status: string | null; seenAt: string | null } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  const load = async () => {
    try {
      const result = await api.get<{
        tunnel: TunnelSnapshot | null;
        cached?: { hostname: string | null; mode: string | null; status: string | null; seenAt: string | null } | null;
        unreachable?: string;
      }>(`/api/nodes/${node.id}/tunnel`);
      setTunnel(result.tunnel);
      setCached(result.cached ?? null);
      setUnreachable(result.unreachable ?? null);
      if (result.tunnel?.configured) {
        setMode(result.tunnel.mode);
        setHostname(result.tunnel.hostname ?? "");
        setLocalPort(String(Number(result.tunnel.localUrl.split(":").pop()) || node.port));
      }
    } catch (error) {
      // A node that cannot be reached has no live tunnel state; the cache and the banner explain why.
      setTunnel(null);
      setUnreachable(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    if (!open) return;
    setCheck(null);
    setToken("");
    void load();
    api.get<{ limits: string[] }>("/api/tunnels/cloudflared").then((result) => setLimits(result.limits)).catch(() => setLimits([]));
  }, [open, node.id]);

  // While the tunnel is starting, poll so the hostname and status appear on their own.
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [open, node.id]);

  useEffect(() => {
    if (showLog && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [tunnel?.log.length, showLog]);

  const save = async () => {
    setBusy("save");
    try {
      const result = await api.put<{ tunnel: TunnelSnapshot }>(`/api/nodes/${node.id}/tunnel`, {
        mode,
        hostname: hostname.trim() || null,
        token: token.trim() === "" ? undefined : token.trim(),
        localPort: Number(localPort) || node.port,
      });
      setTunnel(result.tunnel);
      setToken("");
      toast.success("Tunnel saved", mode === "quick" ? "Start it to get a temporary hostname." : "Start it to connect your domain.");
      onChanged();
    } catch (error) {
      toast.fromError(error, "Could not save the tunnel");
    } finally {
      setBusy(null);
    }
  };

  const action = async (what: "start" | "stop" | "remove" | "use-address") => {
    setBusy(what);
    try {
      if (what === "start") {
        const result = await api.post<{ tunnel: TunnelSnapshot }>(`/api/nodes/${node.id}/tunnel/start`);
        setTunnel(result.tunnel);
        toast.success("Tunnel starting", "cloudflared is connecting to Cloudflare.");
      } else if (what === "stop") {
        const result = await api.post<{ tunnel: TunnelSnapshot }>(`/api/nodes/${node.id}/tunnel/stop`);
        setTunnel(result.tunnel);
        toast.success("Tunnel stopped");
      } else if (what === "remove") {
        await api.delete(`/api/nodes/${node.id}/tunnel`);
        setTunnel(null);
        setHostname("");
        setToken("");
        toast.success("Tunnel configuration removed");
      } else {
        const result = await api.post<{ message: string }>(`/api/nodes/${node.id}/tunnel/use-address`);
        toast.success("Node address updated", result.message);
      }
      onChanged();
      await load();
    } catch (error) {
      toast.fromError(error, what === "start" ? "Could not start the tunnel" : "Tunnel action failed");
    } finally {
      setBusy(null);
    }
  };

  const runCheck = async () => {
    setBusy("check");
    try {
      const result = await api.post<CheckResult>(`/api/nodes/${node.id}/tunnel/check`);
      setCheck(result);
      if (result.reachable) toast.success("Tunnel is reachable", result.detail);
      else toast.error("Tunnel is not reachable yet", result.detail);
    } catch (error) {
      toast.fromError(error, "Could not check the tunnel");
    } finally {
      setBusy(null);
    }
  };

  const installCloudflared = async () => {
    setInstalling(true);
    try {
      const result = await api.post<{ installed: { version: string; verification: string } }>("/api/tunnels/cloudflared/install");
      toast.success(`cloudflared ${result.installed.version} installed`, result.installed.verification);
      await load();
    } catch (error) {
      toast.fromError(error, "Could not install cloudflared");
    } finally {
      setInstalling(false);
    }
  };

  const binary = tunnel?.cloudflared;
  const running = tunnel?.status === "running" || tunnel?.status === "starting";
  const editable = can("node.manage");

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="wide"
      icon={<Cloud size={14} />}
      title={<>{node.isLocal ? "This panel" : node.name} · Cloudflare Tunnel</>}
      footer={
        <div className="row" style={{ justifyContent: "space-between", width: "100%", gap: 8, flexWrap: "wrap" }}>
          <span className="text-xs faint">
            {node.isLocal
              ? "A tunnel here publishes this panel itself — the local node runs inside it."
              : "The tunnel runs on the node's own machine; this dialog drives it there."}
          </span>
          <div className="row" style={{ gap: 8 }}>
            <Button variant="ghost" onClick={onClose}>Close</Button>
            {editable ? (
              <Button variant="primary" icon={<UploadCloud size={13} />} loading={busy === "save"} onClick={() => void save()}>Save</Button>
            ) : null}
          </div>
        </div>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        {/* ------------------------------- binary ------------------------------- */}
        {binary && !binary.path ? (
          <Banner tone="warning" title="cloudflared is not on this machine">
            <div className="stack" style={{ gap: 8 }}>
              <span>{binary.problem}</span>
              {binary.installable && can("system.manage") ? (
                <div className="row" style={{ gap: 8 }}>
                  <Button icon={<DownloadCloud size={13} />} loading={installing} onClick={() => void installCloudflared()}>
                    Install cloudflared
                  </Button>
                  <span className="text-xs faint">Saved to <span className="mono">{binary.installPath}</span></span>
                </div>
              ) : null}
            </div>
          </Banner>
        ) : binary?.path ? (
          <div className="row" style={{ gap: 8, flexWrap: "wrap", fontSize: 12 }}>
            <Pill tone="green" dot>cloudflared {binary.version}</Pill>
            <span className="mono text-xs faint">{binary.path}</span>
            <span className="text-xs faint">({binary.source === "managed" ? "installed by this panel" : binary.source === "path" ? "from PATH" : "from RSLMC_CLOUDFLARED_PATH"})</span>
          </div>
        ) : null}

        {/* -------------------------------- status ------------------------------- */}
        {tunnel?.configured ? (
          <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Pill tone={tunnel.status === "running" ? "green" : tunnel.status === "failed" ? "red" : tunnel.status === "starting" ? "amber" : "neutral"} dot>
              {tunnel.status}
            </Pill>
            <Pill tone={tunnel.mode === "token" ? "blue" : "amber"}>{tunnel.mode === "token" ? "custom domain" : "temporary hostname"}</Pill>
            {tunnel.hostname ? <CopyValue value={`https://${tunnel.hostname}`} title="Copy the public URL" /> : <span className="text-xs faint">no hostname yet</span>}
            <span className="text-xs faint">forwards to <span className="mono">{tunnel.localUrl}</span></span>
          </div>
        ) : null}

        {tunnel?.lastError ? (
          <Banner tone="error" title="Last attempt failed">{tunnel.lastError}</Banner>
        ) : null}
        {!tunnel && unreachable ? (
          <Banner tone="warning" title="This node is not answering">
            <div className="stack" style={{ gap: 6 }}>
              <span>{unreachable}</span>
              {cached?.hostname ? (
                <span>
                  Last known tunnel hostname: <span className="mono">{cached.hostname}</span>
                  {cached.mode ? ` (${cached.mode === "quick" ? "temporary" : "custom domain"})` : ""}
                  {cached.seenAt ? `, seen ${cached.seenAt}` : ""}.
                </span>
              ) : null}
            </div>
          </Banner>
        ) : null}

        {/* -------------------------------- config ------------------------------- */}
        <div className="form-grid">
          <Field label="Mode" hint={mode === "token" ? "Your own domain, created in Cloudflare Zero Trust." : "A random trycloudflare.com name, no account needed."}>
            <Select value={mode} onChange={(event) => setMode(event.target.value as "token" | "quick")} disabled={!editable}>
              <option value="token">My own domain (Cloudflare Tunnel token)</option>
              <option value="quick">Temporary hostname (trycloudflare.com)</option>
            </Select>
          </Field>
          <Field label="Local port" hint="The port on the node that the tunnel forwards to. For this panel it is the panel's own port.">
            <Input type="number" min={1} max={65535} value={localPort} onChange={(event) => setLocalPort(event.target.value)} disabled={!editable} />
          </Field>
        </div>

        {mode === "token" ? (
          <>
            <Field label="Public hostname" hint="Exactly what you created in Cloudflare, e.g. node1.example.com — no https://, no trailing slash.">
              <Input placeholder="node1.example.com" value={hostname} onChange={(event) => setHostname(event.target.value)} disabled={!editable} />
            </Field>
            <Field
              label="Tunnel token"
              hint={tunnel?.hasToken
                ? `A token is stored (…${tunnel.tokenFingerprint}). Leave this empty to keep it, or paste a new one to replace it.`
                : "Zero Trust → Networks → Tunnels → your tunnel → Install connector. The long token, pasted once."}
            >
              <Input type="password" placeholder={tunnel?.hasToken ? "stored — leave empty to keep" : "paste the tunnel token"} value={token} onChange={(event) => setToken(event.target.value)} disabled={!editable} autoComplete="off" />
            </Field>
            <Banner tone="info" title="What to set in Cloudflare">
              Public hostname <span className="mono">{hostname || "node1.example.com"}</span> → service type <span className="mono">HTTP</span> →
              URL <span className="mono">127.0.0.1:{localPort}</span>. Then start the tunnel here. The token is stored encrypted and never shown again.
            </Banner>
          </>
        ) : (
          <Banner tone="warning" title="Temporary means temporary">
            Cloudflare assigns a random hostname each time the tunnel starts and rate-limits these connections. Use it to prove the
            path works, then switch to your own domain. Nothing about your panel changes either way: the same key and the same address rules apply.
          </Banner>
        )}

        {/* -------------------------------- actions ------------------------------ */}
        {editable ? (
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {running ? (
              <Button icon={<Square size={13} />} loading={busy === "stop"} onClick={() => void action("stop")}>Stop tunnel</Button>
            ) : (
              <Button variant="primary" icon={<Play size={13} />} loading={busy === "start"} onClick={() => void action("start")} disabled={!tunnel?.configured && mode === "token" && !token.trim()}>
                Start tunnel
              </Button>
            )}
            <Button icon={<RotateCw size={13} />} loading={busy === "check"} onClick={() => void runCheck()} disabled={!tunnel?.hostname}>Check reachability</Button>
            {!node.isLocal && (tunnel?.hostname || cached?.hostname) ? (
              <Button icon={<CheckCircle2 size={13} />} loading={busy === "use-address"} onClick={() => void action("use-address")}>
                Use as this node's address
              </Button>
            ) : null}
            {tunnel?.configured ? (
              <Button variant="ghost" icon={<Trash2 size={13} />} loading={busy === "remove"} onClick={() => void action("remove")}>Remove</Button>
            ) : null}
            {tunnel?.log.length ? (
              <Button variant="ghost" icon={<Copy size={13} />} onClick={() => setShowLog((value) => !value)}>
                {showLog ? "Hide" : "Show"} cloudflared log
              </Button>
            ) : null}
          </div>
        ) : (
          <Banner tone="info" title="Read-only">You can see this tunnel but not change it. That needs the node.manage permission.</Banner>
        )}

        {check ? (
          <Banner tone={check.reachable ? "success" : "warning"} title={check.reachable ? "Reachable from the internet" : "Not reachable yet"}>
            {check.detail}
          </Banner>
        ) : null}

        {showLog && tunnel?.log.length ? (
          <pre ref={logRef} className="code-block mono" style={{ maxHeight: 220, overflow: "auto", fontSize: 11.5, lineHeight: 1.55, margin: 0 }}>
            {tunnel.log.join("\n")}
          </pre>
        ) : null}

        {limits.length > 0 ? (
          <div className="stack" style={{ gap: 4 }}>
            <div className="card-title" style={{ margin: 0 }}>Limits that come with Cloudflare</div>
            {limits.map((line) => (
              <div key={line} className="text-xs faint" style={{ lineHeight: 1.6 }}>· {line}</div>
            ))}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

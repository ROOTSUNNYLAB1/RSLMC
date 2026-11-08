import { useEffect, useMemo, useState } from "react";
import { Boxes, Cpu, Download, KeyRound, RefreshCw, ShieldCheck, Trash2, UserRound } from "lucide-react";
import { Banner, Button, Card, EmptyState, Field, Loading, PageHeader, Pill, Select, StatCard } from "../components/ui";
import { api, errorMessage } from "../lib/api";
import { useSession, useToast } from "../lib/app";

/*
 * Admin → App Runtimes.
 *
 * The sibling of Admin → Java Runtimes, for the software that is not Minecraft. Three questions this page
 * answers, all from the host rather than from a config file:
 *
 *   1. Which Python and Node.js versions exist upstream, and which of them are unpacked here already?
 *   2. Where do those interpreters live, and are they shared between servers (they are, once per version)?
 *   3. Is the service account every app server runs as really unprivileged — and if the panel cannot
 *      switch users on this host, say so instead of showing a green tick.
 */

interface AppVersion {
  version: string;
  line: string;
  lts: boolean;
  releasedAt: number | null;
  unavailableReason?: string;
  source: string;
}

interface AppFamilyInfo {
  family: "python" | "node";
  name: string;
  description: string;
  binary: string;
  entryFile: string;
  packageManager: string;
  docsUrl: string;
  source: string;
  versions: AppVersion[];
  installed: string[];
  error: string | null;
}

interface ServiceAccount {
  user: string;
  exists: boolean;
  uid: number | null;
  gid: number | null;
  groups: string[];
  sudo: boolean;
  home: string | null;
  passwordSet: boolean;
  createdAt: string | null;
  canIsolate: boolean;
  reason: string | null;
  platform: string;
}

export function AppRuntimesPage() {
  const toast = useToast();
  const { can } = useSession();
  const [apps, setApps] = useState<AppFamilyInfo[] | null>(null);
  const [account, setAccount] = useState<ServiceAccount | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [password, setPassword] = useState<string | null>(null);
  const [busyAccount, setBusyAccount] = useState(false);
  const canManage = can("system.manage");

  const load = async () => {
    try {
      const result = await api.get<{ data: AppFamilyInfo[]; serviceAccount: ServiceAccount }>("/api/apps");
      setApps(result.data);
      setAccount(result.serviceAccount);
    } catch (error) {
      toast.error("Could not load app runtimes", errorMessage(error));
      setApps([]);
    }
  };

  useEffect(() => { void load(); }, []);

  const installedCount = useMemo(
    () => (apps ?? []).reduce((sum, app) => sum + app.installed.length, 0),
    [apps],
  );

  const install = async (family: string, version: string) => {
    setInstalling(`${family}:${version}`);
    try {
      await api.post("/api/apps/install", { family, version });
      toast.success(`${version} installed`, "Unpacked once and shared by every server that uses this version.");
      await load();
    } catch (error) {
      toast.error("Install failed", errorMessage(error));
    } finally {
      setInstalling(null);
    }
  };

  const remove = async (family: string, version: string) => {
    try {
      await api.delete(`/api/apps/${family}/${version}`);
      toast.success(`${version} removed`);
      await load();
    } catch (error) {
      // In use by a server: the panel refuses rather than deleting a runtime a server still needs.
      toast.error("Could not remove", errorMessage(error));
    }
  };

  const prepareAccount = async () => {
    setBusyAccount(true);
    setPassword(null);
    try {
      const result = await api.post<{ data: ServiceAccount; created: boolean; password: string | null; notes: string[] }>(
        "/api/apps/service-account",
      );
      setAccount(result.data);
      setPassword(result.password);
      toast.success(
        result.created ? "Service account created" : "Service account checked",
        result.password ? "The generated password is shown once on this page." : "Nothing needed changing.",
      );
    } catch (error) {
      toast.error("Could not prepare the service account", errorMessage(error));
    } finally {
      setBusyAccount(false);
    }
  };

  return (
    <>
      <PageHeader
        title="App Runtimes"
        icon={<Boxes size={19} />}
        subtitle="Python 3 and Node.js interpreters for non-Minecraft servers — downloaded from their official sources, verified, and shared between servers."
        actions={<Button icon={<RefreshCw size={14} />} onClick={() => void load()}>Refresh</Button>}
      />

      {!apps ? <Loading label="Reading Python and Node.js versions…" /> : (
        <>
          <div className="stat-grid" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
            <StatCard
              label="Interpreters installed"
              icon={<Cpu size={11} />}
              accent="var(--green)"
              value={installedCount}
              meta={<span>
                {(() => {
                  const families = (apps ?? []).filter((app) => app.installed.length > 0).length;
                  return `across ${families} famil${families === 1 ? "y" : "ies"}`;
                })()}
              </span>}
            />
            <StatCard
              label="Versions offered"
              icon={<Download size={11} />}
              accent="var(--blue)"
              value={(apps ?? []).reduce((sum, app) => sum + app.versions.filter((v) => !v.unavailableReason).length, 0)}
              meta={<span>live from nodejs.org and python-build-standalone</span>}
            />
            <StatCard
              label="Service account"
              icon={<ShieldCheck size={11} />}
              accent={account?.exists && !account.sudo && account.canIsolate ? "var(--green)" : "var(--amber)"}
              value={account?.exists ? (account.sudo ? "can escalate" : "no sudo") : "missing"}
              meta={<span>{account?.exists ? `${account.user} · uid ${account.uid}` : "app servers cannot be isolated yet"}</span>}
            />
          </div>

          {(apps ?? []).map((app) => (
            <Card
              key={app.family}
              title={`${app.name} — ${app.source}`}
              icon={<Boxes size={12} />}
              actions={
                <Button
                  variant="ghost"
                  icon={<RefreshCw size={12} />}
                  onClick={() => void load()}
                >
                  Reload list
                </Button>
              }
            >
              {app.error ? (
                <Banner tone="warning" title="The version list could not be read">
                  {app.error} — the panel will not offer versions it could not confirm. Servers already using an
                  installed version keep working.
                </Banner>
              ) : (
                <>
                  <div className="text-xs faint" style={{ marginBottom: 10, lineHeight: 1.6 }}>
                    {app.description} Start file: <span className="mono">{app.entryFile}</span> · package manager:{" "}
                    <span className="mono">{app.packageManager}</span> ·{" "}
                    <a href={app.docsUrl} target="_blank" rel="noreferrer noopener" style={{ textDecoration: "underline" }}>
                      documentation
                    </a>
                  </div>

                  <div className="row" style={{ gap: 10, alignItems: "flex-end", marginBottom: 12, flexWrap: "wrap" }}>
                    <Field label="Install a version" hint="Only versions published for this machine's platform are listed.">
                      <Select
                        value={choice[app.family] ?? ""}
                        onChange={(event) => setChoice({ ...choice, [app.family]: event.target.value })}
                      >
                        <option value="">Choose a version…</option>
                        {app.versions.filter((version) => !version.unavailableReason).map((version) => (
                          <option key={version.version} value={version.version}>
                            {version.version}{version.lts ? " (LTS)" : ""}{app.installed.includes(version.version) ? " — installed" : ""}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Button
                      icon={<Download size={12} />}
                      loading={installing === `${app.family}:${choice[app.family] ?? ""}`}
                      disabled={!canManage || !choice[app.family]}
                      onClick={() => void install(app.family, choice[app.family]!)}
                    >
                      Install
                    </Button>
                  </div>

                  {app.installed.length === 0 ? (
                    <EmptyState
                      icon={<Boxes size={17} />}
                      title="No versions installed"
                      description="They install automatically when a server is created with that version, or choose one above."
                    />
                  ) : (
                    <table className="table">
                      <thead><tr><th>Version</th><th>Status</th><th>Used by</th><th className="actions" /></tr></thead>
                      <tbody>
                        {app.installed.map((version) => (
                          <tr key={version}>
                            <td><strong className="mono">{version}</strong></td>
                            <td><Pill tone="green">installed</Pill></td>
                            <td className="text-xs faint">shared interpreters — removing it affects every server on this version</td>
                            <td className="actions">
                              <Button size="sm" variant="danger" icon={<Trash2 size={12} />} disabled={!canManage} onClick={() => void remove(app.family, version)}>
                                Remove
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}

                  {app.versions.some((version) => version.unavailableReason) ? (
                    <div className="text-xs faint" style={{ marginTop: 8 }}>
                      Not offered on this machine:{" "}
                      {app.versions.filter((version) => version.unavailableReason).slice(0, 4).map((version) => (
                        <span key={version.version} className="mono" title={version.unavailableReason}>{version.version} </span>
                      ))}
                    </div>
                  ) : null}
                </>
              )}
            </Card>
          ))}

          <Card title="Service account" icon={<UserRound size={12} />}>
            <div className="info-list">
              <div className="info-row"><span className="k">Account</span><span className="v mono">{account?.user ?? "rslmc-nonroot"}</span></div>
              <div className="info-row"><span className="k">Exists</span><span className="v">{account?.exists ? <Pill tone="green">yes</Pill> : <Pill tone="amber">no</Pill>}</span></div>
              <div className="info-row"><span className="k">Uid / Gid</span><span className="v mono">{account?.uid !== null && account?.uid !== undefined ? `${account.uid} / ${account.gid}` : "—"}</span></div>
              <div className="info-row"><span className="k">Home</span><span className="v mono text-xs">{account?.home ?? "—"}</span></div>
              <div className="info-row"><span className="k">Password</span><span className="v">{account?.passwordSet ? <Pill tone="green">set</Pill> : <Pill tone="amber">not set</Pill>}</span></div>
              <div className="info-row"><span className="k">Sudo</span><span className="v">{account?.sudo ? <Pill tone="red">available — not isolated</Pill> : <Pill tone="green">unavailable</Pill>}</span></div>
              <div className="info-row">
                <span className="k">User switching</span>
                <span className="v">{account?.canIsolate ? <Pill tone="green">available</Pill> : <Pill tone="amber">unavailable</Pill>}</span>
              </div>
            </div>

            {account && !account.canIsolate ? (
              <Banner tone="warning" title="App servers cannot be isolated on this host right now">
                {account.reason ?? "The panel cannot switch to another account here."}
              </Banner>
            ) : null}

            {account?.sudo ? (
              <Banner tone="error" title="The service account can escalate">
                This account is in a sudo-capable group. App servers would not be isolated. Preparing the account
                again removes those memberships — the panel reports exactly what it changed.
              </Banner>
            ) : null}

            {password ? (
              <Banner tone="info" title="Password set — shown once">
                Password for <span className="mono">{account?.user}</span>: <span className="mono">{password}</span>
                <div className="text-xs faint" style={{ marginTop: 6 }}>
                  Copy it now if you need it (SFTP, for example). The panel stores only the hash on the system,
                  never the password itself.
                </div>
              </Banner>
            ) : null}

            <div className="row" style={{ marginTop: 10, gap: 8, alignItems: "center" }}>
              <Button
                variant="primary"
                icon={<KeyRound size={12} />}
                loading={busyAccount}
                disabled={!canManage}
                onClick={() => void prepareAccount()}
              >
                {account?.exists ? "Check and repair account" : "Create account"}
              </Button>
              <span className="text-xs faint">
                Creates a normal account with a password, its own home, and no sudo. Runs on this machine only.
              </span>
            </div>
          </Card>
        </>
      )}
    </>
  );
}

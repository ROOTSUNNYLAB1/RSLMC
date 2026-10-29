import { useEffect, useMemo, useState } from "react";
import {
  Ban, Backpack, Crown, ShieldCheck, ShieldOff, UserMinus, UserPlus, Users2, X, Search, History, Hammer,
} from "lucide-react";
import type { ServerSummary } from "../../src/shared/types";
import { Button, Card, ConfirmDialog, EmptyState, Field, Input, Loading, Modal, PageHeader, Pill, StatCard, Tabs, Toggle, Banner } from "../components/ui";
import { api, errorMessage } from "../lib/api";
import { useSession, useToast } from "../lib/app";
import { usePanelSocket } from "../lib/ws";
import { formatDuration, relativeTime } from "../lib/format";
import { PlayerInspector } from "../components/player-inspector";

interface PlayerRecord {
  id: number; uuid: string; username: string; online: boolean; operator: boolean;
  whitelisted: boolean; banned: boolean; lastSeenAt: string | null; lastJoinAt: string | null;
  firstSeenAt: string; playtimeSeconds: number; sessionStartAt: string | null;
}

interface PlayersResponse {
  data: PlayerRecord[];
  online: { name: string; uuid: string | null; joinedAt: number | null; sessionSeconds: number | null; operator: boolean; whitelisted: boolean }[];
  counts: { online: number; operators: number; whitelist: number; banned: number; known: number };
  whitelistEnabled: boolean;
  live: boolean;
}

function avatarUrl(uuid: string | null, size = 34): string | null {
  if (!uuid || uuid.startsWith("offline:")) return null;
  return `https://crafatar.com/avatars/${uuid}?size=${size}&overlay&default=MHF_Steve`;
}

export function PlayersPage({ server }: { server: ServerSummary }) {
  const { can } = useSession();
  const toast = useToast();
  const [payload, setPayload] = useState<PlayersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"online" | "all" | "operators" | "whitelist" | "banned">("online");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [addMode, setAddMode] = useState<"whitelist" | "op" | "ban">("whitelist");
  const [confirm, setConfirm] = useState<{ type: string; username: string; title: string; message: string } | null>(null);
  const [detailPlayer, setDetailPlayer] = useState<PlayerRecord | null>(null);
  const [inspecting, setInspecting] = useState<PlayerRecord | null>(null);
  const [sessions, setSessions] = useState<any[]>([]);

  const load = async () => {
    try {
      const data = await api.get<PlayersResponse>(`/api/servers/${server.id}/players`);
      setPayload(data);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [server.id]);

  usePanelSocket(server.id, (message) => {
    if (message.type === "players" || message.type === "status") void load();
  });

  const act = async (type: string, username: string, reason?: string) => {
    setBusy(`${type}:${username}`);
    try {
      const result = await api.post<{ message: string; live: boolean }>(`/api/servers/${server.id}/players/action`, { type, username, reason });
      toast.success("Player updated", result.message);
      await load();
    } catch (err) {
      toast.fromError(err, `Could not ${type.replace(".", " ")} ${username}`);
    } finally {
      setBusy(null);
    }
  };

  const toggleWhitelist = async (enabled: boolean) => {
    try {
      await api.post(`/api/servers/${server.id}/players/whitelist`, { enabled });
      toast.success(enabled ? "Whitelist enabled" : "Whitelist disabled");
      await load();
    } catch (err) {
      toast.fromError(err, "Could not change the whitelist setting");
    }
  };

  const openDetail = async (player: PlayerRecord) => {
    setDetailPlayer(player);
    setSessions([]);
    try {
      const result = await api.get<{ data: any[] }>(`/api/servers/${server.id}/players/${player.uuid}/sessions`);
      setSessions(result.data);
    } catch { /* sessions may be unavailable for imported players */ }
  };

  const filtered = useMemo(() => {
    if (!payload) return [];
    const needle = search.trim().toLowerCase();
    const list = tab === "online"
      ? payload.data.filter((player) => player.online)
      : tab === "operators" ? payload.data.filter((player) => player.operator)
      : tab === "whitelist" ? payload.data.filter((player) => player.whitelisted)
      : tab === "banned" ? payload.data.filter((player) => player.banned)
      : payload.data;
    return needle ? list.filter((player) => player.username.toLowerCase().includes(needle)) : list;
  }, [payload, tab, search]);

  if (loading) return <Loading label="Loading players…" minHeight={280} />;
  if (error) {
    return <Banner tone="error" title="Could not load players">{error}<Button size="sm" style={{ marginLeft: 8 }} onClick={() => void load()}>Retry</Button></Banner>;
  }

  const counts = payload?.counts ?? { online: 0, operators: 0, whitelist: 0, banned: 0, known: 0 };
  const editable = can("server.players");

  return (
    <>
      <PageHeader
        title="Players"
        icon={<Users2 size={19} />}
        subtitle={<>Manage players for <strong style={{ color: "var(--text)" }}>{server.name}</strong>{payload?.live ? <Pill tone="green" dot>live</Pill> : <Pill tone="neutral">server offline</Pill>}</>}
        actions={
          <>
            <Button icon={<UserPlus size={14} />} onClick={() => { setAddMode("whitelist"); setAddOpen(true); }} disabled={!editable}>
              Add player
            </Button>
            <Button variant="danger" icon={<Hammer size={14} />} onClick={() => { setAddMode("ban"); setAddOpen(true); }} disabled={!editable}>
              Ban player
            </Button>
          </>
        }
      />

      <div className="stat-grid" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
        <StatCard
          label="Online now" icon={<Users2 size={11} />} accent="var(--green)"
          value={counts.online} unit={`/ ${server.maxPlayers}`}
          meta={<span>currently in-game</span>}
          trailing={<Users2 size={13} color="var(--green)" />}
        />
        <StatCard
          label="Operators" icon={<Crown size={11} />} accent="var(--amber)"
          value={counts.operators}
          meta={<span>with admin privileges</span>}
          trailing={<Crown size={13} color="var(--amber)" />}
        />
        <StatCard
          label="Whitelisted" icon={<ShieldCheck size={11} />} accent="var(--blue)"
          value={counts.whitelist}
          meta={<span>{payload?.whitelistEnabled ? "whitelist enforced" : "whitelist disabled"}</span>}
          trailing={<ShieldCheck size={13} color="var(--blue)" />}
        />
        <StatCard
          label="Banned" icon={<Ban size={11} />} accent="var(--red)"
          value={counts.banned}
          meta={<span>restricted accounts</span>}
          trailing={<Ban size={13} color="var(--red)" />}
        />
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "online", label: "Online", count: counts.online },
          { id: "all", label: "All players", count: counts.known },
          { id: "operators", label: "Operators", count: counts.operators },
          { id: "whitelist", label: "Whitelist", count: counts.whitelist },
          { id: "banned", label: "Banned", count: counts.banned },
        ]}
        right={
          <div className="row" style={{ gap: 10 }}>
            <div className="row" style={{ gap: 6 }}>
              <Search size={12} className="faint" />
              <input className="input" style={{ height: 27, width: 170 }} placeholder="Search players…" value={search} onChange={(event) => setSearch(event.target.value)} />
            </div>
            <div className="row" style={{ gap: 8, borderLeft: "1px solid var(--border)", paddingLeft: 10 }}>
              <span className="text-xs faint">Whitelist enabled</span>
              <Toggle checked={payload?.whitelistEnabled ?? false} onChange={(value) => void toggleWhitelist(value)} disabled={!editable} />
            </div>
          </div>
        }
      />

      <Card title="Online players" icon={<Users2 size={12} />} bodyClass="tight" actions={<span className="text-xs faint row" style={{ gap: 6 }}><span className="live-dot" /> Auto-updates · live</span>}>
        {filtered.length === 0 ? (
          <EmptyState
            icon={<Users2 size={17} />}
            title={tab === "online" ? "No players online" : `No ${tab === "all" ? "" : tab} players`}
            description={
              tab === "online"
                ? payload?.live
                  ? "The server is running but nobody is connected right now. Player cards appear here as soon as someone joins."
                  : "The server is offline. Start it from the Overview page to track players in real time."
                : "Player records are collected from the server's own JSON files and join/leave events."
            }
          />
        ) : (
          <div className="player-grid">
            {filtered.map((player) => (
              <div className="player-card" key={player.uuid}>
                <div className="player-avatar">
                  {avatarUrl(player.uuid) ? (
                    <img src={avatarUrl(player.uuid)!} alt="" width={34} height={34} style={{ imageRendering: "pixelated" }} onError={(event) => { (event.currentTarget as HTMLImageElement).style.display = "none"; }} />
                  ) : (
                    <span>{player.username.slice(0, 2).toUpperCase()}</span>
                  )}
                </div>
                <div className="player-meta">
                  <button
                    className="name player-name-button"
                    onClick={() => setInspecting(player)}
                    title={`Open ${player.username}'s inventory and vitals`}
                  >
                    {player.username}
                  </button>
                  <div className="sub">
                    {player.online ? (
                      <><span className="live-dot" style={{ width: 5, height: 5 }} /> in-game</>
                    ) : player.banned ? (
                      <span style={{ color: "#f28b8b" }}>banned</span>
                    ) : (
                      <span>{player.lastSeenAt ? `seen ${relativeTime(player.lastSeenAt)}` : "never seen"}</span>
                    )}
                    {player.operator ? <Crown size={9} color="var(--amber)" aria-label="Operator" /> : null}
                  </div>
                </div>
                <div className="row" style={{ gap: 3 }}>
                  <button className="btn btn-sm btn-ghost btn-icon" title="Inventory & vitals" aria-label={`Inventory for ${player.username}`} onClick={() => setInspecting(player)}>
                    <Backpack size={12} />
                  </button>
                  <button className="btn btn-sm btn-ghost btn-icon" title="Player details" aria-label={`Details for ${player.username}`} onClick={() => void openDetail(player)}>
                    <History size={12} />
                  </button>
                  {player.online ? (
                    <button
                      className="btn btn-sm btn-danger btn-icon" title={`Kick ${player.username}`} aria-label={`Kick ${player.username}`}
                      disabled={!editable || busy === `kick:${player.username}`}
                      onClick={() => setConfirm({ type: "kick", username: player.username, title: `Kick ${player.username}?`, message: "The player is disconnected immediately. They can rejoin unless banned." })}
                    >
                      <UserMinus size={12} />
                    </button>
                  ) : player.banned ? (
                    <button
                      className="btn btn-sm btn-icon" title={`Unban ${player.username}`} aria-label={`Unban ${player.username}`}
                      disabled={!editable || busy === `pardon:${player.username}`}
                      onClick={() => void act("pardon", player.username)}
                    >
                      <ShieldOff size={12} />
                    </button>
                  ) : (
                    <button
                      className="btn btn-sm btn-danger btn-icon" title={`Ban ${player.username}`} aria-label={`Ban ${player.username}`}
                      disabled={!editable}
                      onClick={() => setConfirm({ type: "ban", username: player.username, title: `Ban ${player.username}?`, message: "The account is added to banned-players.json and kicked if online." })}
                    >
                      <Ban size={12} />
                    </button>
                  )}
                  <button
                    className="btn btn-sm btn-ghost btn-icon" title={player.operator ? `Remove operator from ${player.username}` : `Make ${player.username} an operator`}
                    aria-label={player.operator ? "Remove operator" : "Give operator"}
                    disabled={!editable}
                    onClick={() => void act(player.operator ? "deop" : "op", player.username)}
                  >
                    <Crown size={12} color={player.operator ? "var(--amber)" : undefined} />
                  </button>
                  <button
                    className="btn btn-sm btn-ghost btn-icon" title={player.whitelisted ? "Remove from whitelist" : "Add to whitelist"}
                    aria-label={player.whitelisted ? "Remove from whitelist" : "Add to whitelist"}
                    disabled={!editable}
                    onClick={() => void act(player.whitelisted ? "whitelist.remove" : "whitelist.add", player.username)}
                  >
                    <ShieldCheck size={12} color={player.whitelisted ? "var(--blue)" : undefined} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title={addMode === "ban" ? "Ban a player" : addMode === "op" ? "Give operator privileges" : "Add to whitelist"}
        footer={
          <>
            <Button onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button
              variant={addMode === "ban" ? "danger" : "primary"}
              loading={busy !== null}
              onClick={async () => {
                const name = addName.trim();
                if (!name) return;
                await act(addMode, name);
                setAddName("");
                setAddOpen(false);
              }}
            >
              {addMode === "ban" ? "Ban player" : addMode === "op" ? "Give operator" : "Add to whitelist"}
            </Button>
          </>
        }
      >
        <Field label="Minecraft username" hint="RSLMC resolves the real UUID from Mojang for online-mode servers, and derives the offline UUID otherwise.">
          <Input value={addName} onChange={(event) => setAddName(event.target.value)} placeholder="Notch" autoFocus />
        </Field>
        {!payload?.live ? (
          <Banner tone="info" title="Server is offline">
            The change is written to the server's JSON files and takes effect the next time it starts.
          </Banner>
        ) : null}
        <div className="row" style={{ gap: 8 }}>
          <span className="text-xs faint">Action</span>
          <select className="select" style={{ height: 28, width: 150 }} value={addMode} onChange={(event) => setAddMode(event.target.value as any)}>
            <option value="whitelist">Whitelist</option>
            <option value="op">Operator</option>
            <option value="ban">Ban</option>
          </select>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.title ?? ""}
        message={confirm?.message ?? ""}
        confirmLabel={confirm?.type === "kick" ? "Kick player" : "Ban player"}
        onClose={() => setConfirm(null)}
        busy={busy !== null}
        onConfirm={async () => {
          if (!confirm) return;
          await act(confirm.type, confirm.username);
          setConfirm(null);
        }}
      />

      <Modal open={detailPlayer !== null} onClose={() => setDetailPlayer(null)} title={detailPlayer?.username ?? "Player"} size="wide">
        {detailPlayer ? (
          <>
            <div className="grid grid-2" style={{ gap: 12 }}>
              <div className="card">
                <div className="info-list">
                  <div className="info-row"><span className="k">UUID</span><span className="v mono text-xs">{detailPlayer.uuid}</span></div>
                  <div className="info-row"><span className="k">Status</span><span className="v">{detailPlayer.online ? <Pill tone="green" dot>online</Pill> : "offline"}</span></div>
                  <div className="info-row"><span className="k">Operator</span><span className="v">{detailPlayer.operator ? "Yes" : "No"}</span></div>
                  <div className="info-row"><span className="k">Whitelisted</span><span className="v">{detailPlayer.whitelisted ? "Yes" : "No"}</span></div>
                  <div className="info-row"><span className="k">Banned</span><span className="v">{detailPlayer.banned ? "Yes" : "No"}</span></div>
                </div>
              </div>
              <div className="card">
                <div className="info-list">
                  <div className="info-row"><span className="k">First seen</span><span className="v">{relativeTime(detailPlayer.firstSeenAt)}</span></div>
                  <div className="info-row"><span className="k">Last join</span><span className="v">{relativeTime(detailPlayer.lastJoinAt)}</span></div>
                  <div className="info-row"><span className="k">Last seen</span><span className="v">{relativeTime(detailPlayer.lastSeenAt)}</span></div>
                  <div className="info-row"><span className="k">Playtime</span><span className="v">{formatDuration(detailPlayer.playtimeSeconds)}</span></div>
                  <div className="info-row"><span className="k">Known sessions</span><span className="v">{sessions.length}</span></div>
                </div>
              </div>
            </div>
            <div className="card" style={{ maxHeight: 240, overflowY: "auto" }}>
              <table className="table">
                <thead><tr><th>Joined</th><th>Left</th><th>Duration</th></tr></thead>
                <tbody>
                  {sessions.length === 0 ? (
                    <tr><td colSpan={3} className="faint text-xs">No session history recorded yet. RSLMC records sessions it observes in the console.</td></tr>
                  ) : sessions.map((session) => (
                    <tr key={session.id}>
                      <td>{new Date(session.joined_at).toLocaleString()}</td>
                      <td>{session.left_at ? new Date(session.left_at).toLocaleString() : <Pill tone="green">in-game</Pill>}</td>
                      <td>{session.duration_seconds ? formatDuration(session.duration_seconds) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </Modal>

      <PlayerInspector
        open={inspecting !== null}
        onClose={() => setInspecting(null)}
        serverId={server.id}
        uuid={inspecting?.uuid || inspecting?.username || ""}
        username={inspecting?.username ?? ""}
        onChanged={() => void load()}
      />
    </>
  );
}

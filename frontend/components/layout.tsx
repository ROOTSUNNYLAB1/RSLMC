import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity, Archive, Bell, Boxes, ChevronRight, CircleUser, Cog, Database, FileCode2,
  Files, Gauge, Globe2, Home, LayoutDashboard, ListChecks, Map as MapIcon, Maximize2, Menu,
  Minimize2, Network, Plug, ShieldCheck, Terminal, Users2, Earth, Power, Cpu, ScrollText, ServerCog,
} from "lucide-react";
import { Link, useRouter } from "../lib/router";
import { useSession } from "../lib/app";
import { panelSocket, usePanelSocket } from "../lib/ws";
import type { ServerSummary } from "../../src/shared/types";
import { Avatar, Pill } from "./ui";
import { statusLabel, statusTone } from "../lib/format";

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  permission?: string | string[];
  badge?: number;
}

export function Sidebar({
  server, open, onNavigate,
}: {
  server: ServerSummary | null;
  open: boolean;
  onNavigate: () => void;
}) {
  const { path, navigate } = useRouter();
  const { user, unreadNotifications, logout, can } = useSession();

  const globalNav: NavItem[] = [
    { to: "/dashboard", label: "Dashboard", icon: <LayoutDashboard size={14} /> },
    { to: "/servers", label: "Servers", icon: <ServerCog size={14} /> },
  ];

  // Mirrors SERVER_PAGES in App.tsx: a link only exists when the page behind it would render.
  const serverNav: NavItem[] = server ? [
    { to: `/servers/${server.id}/overview`, label: "Overview", icon: <LayoutDashboard size={14} /> },
    { to: `/servers/${server.id}/console`, label: "Console", icon: <Terminal size={14} /> },
    { to: `/servers/${server.id}/files`, label: "Files", icon: <Files size={14} />, permission: "server.files" },
    { to: `/servers/${server.id}/properties`, label: "Properties", icon: <FileCode2 size={14} />, permission: "server.files" },
    { to: `/servers/${server.id}/players`, label: "Players", icon: <Users2 size={14} />, permission: "server.players" },
    { to: `/servers/${server.id}/plugins`, label: "Plugins", icon: <Plug size={14} />, permission: "server.plugins" },
    { to: `/servers/${server.id}/worlds`, label: "Worlds", icon: <Earth size={14} />, permission: "server.worlds" },
    { to: `/servers/${server.id}/map`, label: "Map", icon: <MapIcon size={14} /> },
    { to: `/servers/${server.id}/backups`, label: "Backups", icon: <Archive size={14} />, permission: "server.backups" },
    { to: `/servers/${server.id}/activity`, label: "Activity", icon: <Activity size={14} /> },
    { to: `/servers/${server.id}/schedules`, label: "Schedules", icon: <ListChecks size={14} />, permission: "server.schedules" },
    { to: `/servers/${server.id}/databases`, label: "Databases", icon: <Database size={14} />, permission: "server.settings" },
    { to: `/servers/${server.id}/startup`, label: "Startup", icon: <Power size={14} />, permission: ["server.settings", "server.startup"] },
    { to: `/servers/${server.id}/networking`, label: "Networking", icon: <Network size={14} />, permission: "server.allocations" },
    { to: `/servers/${server.id}/settings`, label: "Settings", icon: <Cog size={14} />, permission: "server.settings" },
  ] : [];

  const accountNav: NavItem[] = [
    { to: "/account", label: "My Profile", icon: <CircleUser size={14} /> },
    { to: "/notifications", label: "Notifications", icon: <Bell size={14} />, badge: unreadNotifications },
  ];

  const adminNav: NavItem[] = [
    { to: "/admin", label: "Admin Panel", icon: <ShieldCheck size={14} />, permission: ["node.view", "user.view", "system.manage", "audit.view"] },
  ];

  const renderItem = (item: NavItem) => {
    if (item.permission && !can(item.permission)) return null;
    const active = path === item.to || (item.to !== "/dashboard" && path.startsWith(item.to) && item.to.split("/").length > 2);
    return (
      <Link key={item.to} to={item.to} className={`nav-item ${active ? "active" : ""}`} onClick={onNavigate}>
        <span className="nav-icon">{item.icon}</span>
        <span>{item.label}</span>
        {item.badge ? <span className="nav-badge">{item.badge > 9 ? "9+" : item.badge}</span> : null}
      </Link>
    );
  };

  return (
    <aside className={`sidebar ${open ? "open" : ""}`} aria-label="Main navigation">
      <div className="sidebar-brand">
        <span className="brand-mark" aria-hidden>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
            <rect x="3" y="3" width="8" height="8" rx="1.4" fill="#3ecf72" opacity="0.9" />
            <rect x="13" y="3" width="8" height="8" rx="1.4" fill="#3ecf72" opacity="0.45" />
            <rect x="3" y="13" width="8" height="8" rx="1.4" fill="#3ecf72" opacity="0.45" />
            <rect x="13" y="13" width="8" height="8" rx="1.4" fill="#3ecf72" opacity="0.22" />
          </svg>
        </span>
        <div>
          <div className="brand-name">RSLMC</div>
          <div className="brand-sub">Server Panel</div>
        </div>
      </div>

      <div className="sidebar-scroll">
        <div className="nav-section">
          <div className="nav-section-label">Navigation</div>
          {globalNav.map(renderItem)}
        </div>

        {server ? (
          <>
            <div className="nav-section">
              {/* Status lives in the section heading so the long server menu stays compact. */}
              <div className="nav-section-label nav-section-label-row" title={server.name}>
                <span className="truncate">{server.name.length > 18 ? `${server.name.slice(0, 17)}…` : server.name}</span>
                <span className="nav-section-status">
                  <Pill tone={statusTone(server.status)} dot>{statusLabel(server.status)}</Pill>
                </span>
              </div>
              {serverNav.map(renderItem)}
            </div>
          </>
        ) : null}

        <div className="nav-section">
          <div className="nav-section-label">Account</div>
          {accountNav.map(renderItem)}
        </div>

        {/* The whole section disappears for accounts without any administration permission —
            an empty "Administration" heading only advertises what they cannot open. */}
        {adminNav.some((item) => !item.permission || can(item.permission)) ? (
          <div className="nav-section">
            <div className="nav-section-label">Administration</div>
            {adminNav.map(renderItem)}
          </div>
        ) : null}
      </div>

      <div className="sidebar-footer">
        <Avatar
          name={user?.username ?? "??"}
          color={user?.avatarColor}
          url={user?.avatarUrl}
          size={28}
        />
        <div className="who" style={{ minWidth: 0 }}>
          <b className="truncate">{user?.username ?? "—"}</b>
          <span className="truncate" style={{ display: "block" }}>{user?.roles[0] ?? "No role"}</span>
        </div>
        <button
          className="icon-btn"
          style={{ marginLeft: "auto" }}
          title="Sign out"
          aria-label="Sign out"
          onClick={() => { void logout(); }}
        >
          <Power size={14} />
        </button>
      </div>
    </aside>
  );
}

export function TopBar({
  crumbs, onToggleSidebar, socketState,
}: {
  crumbs: { label: string; to?: string }[];
  onToggleSidebar: () => void;
  socketState: "connecting" | "open" | "closed";
}) {
  const { navigate } = useRouter();
  const { unreadNotifications } = useSession();
  const [fullscreen, setFullscreen] = useState(false);

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
        setFullscreen(true);
      } else {
        await document.exitFullscreen();
        setFullscreen(false);
      }
    } catch { /* the browser may block this */ }
  };

  return (
    <header className="topbar">
      <button className="icon-btn mobile-only" onClick={onToggleSidebar} aria-label="Open navigation menu">
        <Menu size={16} />
      </button>
      <div className="crumbs">
        <button className="home-btn" onClick={() => navigate("/dashboard")} aria-label="Dashboard">
          <Home size={14} />
        </button>
        {crumbs.map((crumb, index) => (
          <span key={`${crumb.label}-${index}`} className="row" style={{ gap: 7 }}>
            <ChevronRight size={12} className="sep" aria-hidden />
            {crumb.to ? (
              <span className="link" onClick={() => navigate(crumb.to!)}>{crumb.label}</span>
            ) : (
              <span className="leaf">{crumb.label}</span>
            )}
          </span>
        ))}
      </div>
      <div className="topbar-actions">
        <span
          className="pill pill-neutral"
          title={socketState === "open" ? "Live connection established" : socketState === "connecting" ? "Connecting to the live channel" : "Live channel disconnected — retrying"}
          aria-label="Live connection status"
        >
          <span style={{ width: 5, height: 5, borderRadius: "50%", background: socketState === "open" ? "var(--green)" : socketState === "connecting" ? "var(--amber)" : "var(--red)" }} />
          {socketState === "open" ? "Live" : socketState === "connecting" ? "Connecting" : "Offline"}
        </span>
        <button className="icon-btn" onClick={() => navigate("/notifications")} aria-label={`Notifications (${unreadNotifications} unread)`}>
          <Bell size={15} />
          {unreadNotifications > 0 ? <span className="dot">{unreadNotifications > 9 ? "9+" : unreadNotifications}</span> : null}
        </button>
        <button className="icon-btn" onClick={() => void toggleFullscreen()} aria-label="Toggle full screen">
          {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
      </div>
    </header>
  );
}

function PanelFooter({ crumbs }: { crumbs: { label: string; to?: string }[] }) {
  const { navigate } = useRouter();
  const { logout } = useSession();
  const current = crumbs.length ? crumbs[crumbs.length - 1] : { label: "Dashboard" };
  return (
    <footer className="panel-footer">
      <span>© {new Date().getFullYear()} RSLMC</span>
      <span className="crumb-sep" aria-hidden>·</span>
      <span>{current.label}</span>
      <div className="links">
        <Link to="/dashboard">Dashboard</Link>
        <Link to="/account">Profile</Link>
        <Link to="/notifications">Notifications</Link>
        <button onClick={() => { void logout(); }}>Logout</button>
      </div>
    </footer>
  );
}

export function useLiveNotifications() {
  const { setUnread } = useSession();
  usePanelSocket(null, (message) => {
    if (message.type === "notification") setUnread((current: number) => current + 1);
  });
}

/**
 * The "update available" strip.
 *
 * It is deliberately quiet: one line, one link, one dismiss. It only appears for accounts that can
 * actually install (system.manage), because telling a `User` about an update they cannot apply is
 * just noise. The state comes from the panel itself — the same SQLite row the About page renders —
 * so it survives page reloads and panel restarts without any extra polling of GitHub.
 */
function UpdateStrip() {
  const [state, setState] = useState<{ version: string; pending: boolean; available: boolean; dismissed: boolean } | null>(null);
  const { navigate } = useRouter();
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const response = await fetch("/api/panel/update", { credentials: "same-origin", cache: "no-store" });
        if (!response.ok) return;               // a User account: nothing to show
        const data = await response.json() as any;
        if (!live) return;
        if (data?.canManage === false) { setState(null); return; }
        setState({
          version: data?.pendingRestartVersion ?? data?.latest?.version ?? "",
          pending: Boolean(data?.pendingRestartVersion),
          available: Boolean(data?.updateAvailable) && !data?.dismissed,
          dismissed: Boolean(data?.dismissed),
        });
      } catch { /* offline: the strip simply does not render */ }
    };
    void load();
    // Cheap: it reads a single row. Re-checked every 90 s and whenever the tab regains focus.
    const timer = setInterval(load, 90_000);
    const onFocus = () => { void load(); };
    window.addEventListener("focus", onFocus);
    return () => { live = false; clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, []);

  if (hidden || !state) return null;
  if (!state.pending && !state.available) return null;

  return (
    <div className="update-strip" role="status">
      <span className="dot" aria-hidden />
      {state.pending ? (
        <span><strong>RSLMC {state.version} is installed.</strong> Restart the panel to start running it — servers stay online.</span>
      ) : (
        <span><strong>Update available for RSLMC</strong> — {state.version} is published.</span>
      )}
      <span className="grow" />
      <button className="btn btn-sm btn-primary" onClick={() => navigate("/admin/about")}>
        {state.pending ? "Restart" : "View update"}
      </button>
      <button className="icon-btn" aria-label="Dismiss update notice" onClick={() => setHidden(true)}>×</button>
    </div>
  );
}

export function Shell({
  server, crumbs, children,
}: {
  server: ServerSummary | null;
  crumbs: { label: string; to?: string }[];
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [socketState, setSocketState] = useState<"connecting" | "open" | "closed">(panelSocket.state);

  useEffect(() => panelSocket.onState(setSocketState), []);
  // Keep one panel-wide socket open for the whole shell so the connection badge and the
  // notification badge stay truthful on every page, not only on pages that subscribe.
  useEffect(() => {
    panelSocket.connect(server?.id ?? null);
  }, [server?.id]);
  useEffect(() => { setOpen(false); }, [crumbs.map((crumb) => crumb.label).join("/")]);

  return (
    <div className="app-shell">
      <Sidebar server={server} open={open} onNavigate={() => setOpen(false)} />
      {open ? <div className="sidebar-backdrop mobile-only" onClick={() => setOpen(false)} aria-hidden /> : null}
      <div className="main">
        <TopBar crumbs={crumbs} onToggleSidebar={() => setOpen((value) => !value)} socketState={socketState} />
        <main className="content" id="main-content">
          <UpdateStrip />
          {children}
        </main>
        <PanelFooter crumbs={crumbs} />
      </div>
    </div>
  );
}

export { Boxes, Database };

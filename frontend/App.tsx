import { useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import { Ban, ChevronRight, Compass, Home, Lock, ServerCog, ShieldAlert } from "lucide-react";
import type { ServerSummary, UserPublic } from "../src/shared/types";
import { Shell } from "./components/layout";
import { Banner, Button, Card, EmptyState, Loading } from "./components/ui";
import { AppProvider, useApi, useSession } from "./lib/app";
import { RouterProvider, useRouter, matchRoute, Link } from "./lib/router";
import { LoginPage, RegisterPage } from "./pages/Login";
import { DashboardPage, ServersPage } from "./pages/Dashboard";
import { ServerOverviewPage } from "./pages/ServerOverview";
import { ConsolePage } from "./pages/Console";
import { FilesPage } from "./pages/Files";
import { PropertiesPage } from "./pages/Properties";
import { PlayersPage } from "./pages/Players";
import { PluginsPage } from "./pages/Plugins";
import { WorldsPage } from "./pages/Worlds";
import { MapPage } from "./pages/MapPage";
import { MapViewPage } from "./pages/MapView";
import { BackupsPage } from "./pages/Backups";
import { SchedulesPage } from "./pages/Schedules";
import { DatabasesPage, SettingsPage, StartupPage } from "./pages/Settings";
import { NetworkingPage } from "./pages/Networking";
import { ActivityPage } from "./pages/Activity";
import { CreateServerPage } from "./pages/CreateServer";
import { AccountPage, NotificationsPage } from "./pages/Account";
import { AdminDashboardPage, AdminNav, AuditPage, JavaPage, NodesPage, RolesPage, SignInPage, SystemPage, UsersPage } from "./pages/Admin";
import { AboutPage } from "./pages/About";

interface SetupStatus {
  needsSetup: boolean;
  mode: string;
  version: string;
  port: number;
  checks: { id: string; label: string; status: string; detail: string }[];
}

/*
 * Server pages and the permission that opens them. Infrastructure pages (startup / resource limits,
 * networking / allocations) are deliberately gated, so a plain "User" account never even renders a
 * page it cannot use — and the API refuses the same calls independently.
 */
const SERVER_PAGES: Record<string, { label: string; permission?: string | string[] }> = {
  overview: { label: "Overview" },
  console: { label: "Console" },
  files: { label: "Files", permission: "server.files" },
  properties: { label: "Properties", permission: "server.files" },
  players: { label: "Players", permission: "server.players" },
  plugins: { label: "Plugins", permission: "server.plugins" },
  worlds: { label: "Worlds", permission: "server.worlds" },
  map: { label: "Map" },
  backups: { label: "Backups", permission: "server.backups" },
  activity: { label: "Activity" },
  schedules: { label: "Schedules", permission: "server.schedules" },
  databases: { label: "Databases", permission: "server.settings" },
  startup: { label: "Startup", permission: ["server.settings", "server.startup"] },
  networking: { label: "Networking", permission: "server.allocations" },
  settings: { label: "Settings", permission: "server.settings" },
};

const ADMIN_PAGES: Record<string, { label: string; permission: string | string[] }> = {
  "": { label: "Admin Panel", permission: "node.view" },
  nodes: { label: "Nodes", permission: "node.view" },
  servers: { label: "Servers", permission: "server.view" },
  users: { label: "Users", permission: "user.view" },
  roles: { label: "Roles", permission: "user.view" },
  signin: { label: "Sign-in", permission: ["system.manage", "user.manage"] },
  java: { label: "Java Runtimes", permission: "java.manage" },
  audit: { label: "Audit Log", permission: "audit.view" },
  system: { label: "System", permission: "system.manage" },
  about: { label: "About", permission: ["system.manage", "node.view"] },
};

function Splash({ label = "Loading RSLMC…" }: { label?: string }) {
  return (
    <div className="auth-shell" style={{ minHeight: "100vh" }}>
      <div className="auth-panel" style={{ display: "grid", placeItems: "center", minHeight: 200 }}>
        <Loading label={label} />
      </div>
    </div>
  );
}

function Forbidden({ permission }: { permission: string | string[] }) {
  const label = Array.isArray(permission) ? permission.join(" or ") : permission;
  return <ForbiddenBody permission={label} />;
}

function ForbiddenBody({ permission }: { permission: string }) {
  return (
    <Card title="Access denied" icon={<Lock size={12} />}>
      <EmptyState
        icon={<Ban size={18} />}
        title="You do not have permission for this page"
        description={`The backend rejected this view because your account is missing the "${permission}" permission. Ask a root administrator to grant it through Roles.`}
        action={<Link to="/dashboard" className="btn"><Home size={14} /> Back to dashboard</Link>}
      />
    </Card>
  );
}

function NotFound() {
  const { navigate } = useRouter();
  return (
    <Card title="Page not found" icon={<Compass size={12} />}>
      <EmptyState
        icon={<Compass size={18} />}
        title="That route does not exist"
        description="The address you followed is not part of the panel. It may have been renamed or removed."
        action={<Button variant="primary" icon={<Home size={14} />} onClick={() => navigate("/dashboard")}>Go to dashboard</Button>}
      />
    </Card>
  );
}

function Permissioned({ permission, children }: { permission?: string | string[]; children: ReactNode }) {
  const { can } = useSession();
  if (permission && !can(permission)) return <Forbidden permission={permission} />;
  return <>{children}</>;
}

function ServerLoading({ id }: { id: number }) {
  return <Loading label={`Loading server #${id}…`} minHeight={280} />;
}

function ServerMissing({ id, message }: { id: number; message?: string }) {
  const { navigate } = useRouter();
  return (
    <Card title="Server unavailable" icon={<ShieldAlert size={12} />}>
      <EmptyState
        icon={<ServerCog size={18} />}
        title={`Server ${id} could not be opened`}
        description={message ?? "The server does not exist, or your account cannot access it."}
        action={<Button variant="primary" onClick={() => navigate("/servers")}>Back to servers</Button>}
      />
    </Card>
  );
}

export function App() {
  const { path, navigate } = useRouter();
  const { user, loading } = useSession();
  const { segments } = matchRoute(path);
  const setup = useApi<SetupStatus>("/api/setup/status");

  // Only the pathname drives the transition key, so query-string changes never remount a page.
  const pathname = path.split("?")[0] ?? "/";
  const serverSegment = segments[0] === "servers" && segments[1] && segments[1] !== "new" ? segments[1] : null;
  const serverId = serverSegment && /^\d+$/.test(serverSegment) ? Number(serverSegment) : null;
  const detail = useApi<{ server: ServerSummary }>(user && serverId ? `/api/servers/${serverId}` : null);

  const signedOut = !loading && !user;

  useEffect(() => {
    // Both auth routes are reachable without a session; everything else bounces to sign-in.
    if (signedOut && segments[0] !== "login" && segments[0] !== "register") navigate("/login", { replace: true });
    if (!loading && user && (segments.length === 0 || segments[0] === "login")) navigate("/dashboard", { replace: true });
  }, [signedOut, loading, user, segments.join("/")]);

  const crumbs = useMemo(() => {
    const build = (): { label: string; to?: string }[] => {
      if (segments.length === 0) return [{ label: "Dashboard" }];
      switch (segments[0]) {
        case "login":
          return [{ label: "Sign in" }];
        case "register":
          return [{ label: "Create account" }];
        case "dashboard":
          return [{ label: "Dashboard" }];
        case "servers": {
          if (segments[1] === "new") return [{ label: "Servers", to: "/servers" }, { label: "Create server" }];
          if (!segments[1]) return [{ label: "Servers" }];
          return [
            { label: "Servers", to: "/servers" },
            { label: detail.data?.server.name ?? `Server ${segments[1]}`, to: `/servers/${segments[1]}/overview` },
            { label: SERVER_PAGES[segments[2] ?? "overview"]?.label ?? "Overview" },
          ];
        }
        case "notifications":
          return [{ label: "Notifications" }];
        case "account":
          return [{ label: "My Profile" }];
        case "activity":
          return [{ label: "Activity" }];
        case "admin":
          return [{ label: "Administration", to: "/admin" }, { label: ADMIN_PAGES[segments[1] ?? ""]?.label ?? "Admin Panel" }];
        default:
          return [{ label: "Not found" }];
      }
    };
    return build();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, detail.data?.server.name]);

  if (loading) return <Splash />;

  if (!user || segments[0] === "login" || segments[0] === "register") {
    // `/register` is a public page; a visitor who is already signed in gets bounced to the dashboard
    // by the page itself, so both routes render through the same guard.
    return segments[0] === "register"
      ? <RegisterPage setup={setup.data ?? null} />
      : <LoginPage setup={setup.data ?? null} />;
  }

  const renderGlobal = (): ReactNode => {
    switch (segments[0]) {
      case "dashboard":
        return <DashboardPage />;
      case "servers":
        return segments[1] === undefined ? <ServersPage /> : segments[1] === "new" ? <CreateServerPage /> : null;
      case "notifications":
        return <NotificationsPage />;
      case "account":
        return <AccountPage />;
      case "activity":
        return <ActivityPage global />;
      case "admin": {
        const key = segments[1] ?? "";
        const meta = ADMIN_PAGES[key];
        if (!meta) return <NotFound />;
        const page =
          key === "" ? <AdminDashboardPage />
            : key === "nodes" ? <NodesPage />
              : key === "servers" ? <ServersPage />
                : key === "users" ? <UsersPage />
                  : key === "roles" ? <RolesPage />
                    : key === "signin" ? <SignInPage />
                    : key === "java" ? <JavaPage />
                      : key === "audit" ? <AuditPage />
                        : key === "about" ? <AboutPage />
                          : <SystemPage />;
        return (
          <Permissioned permission={meta.permission}>
            <AdminNav active={key} />
            {page}
          </Permissioned>
        );
      }
      default:
        return <NotFound />;
    }
  };

  const renderServer = (server: ServerSummary): ReactNode => {
    const page = segments[2] ?? "overview";
    const meta = SERVER_PAGES[page];
    if (!meta) return <NotFound />;
    const content = () => {
      switch (page) {
        case "overview": return <ServerOverviewPage serverId={server.id} />;
        case "console": return <ConsolePage server={server} />;
        case "files": return <FilesPage server={server} />;
        case "properties": return <PropertiesPage server={server} />;
        case "players": return <PlayersPage server={server} />;
        case "plugins": return <PluginsPage server={server} />;
        case "worlds": return <WorldsPage server={server} />;
        case "map": return segments[3] === "view" ? <MapViewPage server={server} /> : <MapPage server={server} />;
        case "backups": return <BackupsPage server={server} />;
        case "activity": return <ActivityPage server={server} />;
        case "schedules": return <SchedulesPage server={server} />;
        case "databases": return <DatabasesPage server={server} />;
        case "startup": return <StartupPage server={server} />;
        case "networking": return <NetworkingPage server={server} />;
        case "settings": return <SettingsPage server={server} />;
        default: return <NotFound />;
      }
    };
    return <Permissioned permission={meta.permission}>{content()}</Permissioned>;
  };

  const body = (): ReactNode => {
    if (segments[0] === "servers" && segments[1] && segments[1] !== "new") {
      if (!serverId) return <NotFound />;
      if (detail.loading) return <ServerLoading id={serverId} />;
      if (!detail.data?.server) return <ServerMissing id={serverId} message={detail.error ?? undefined} />;
      return renderServer(detail.data.server);
    }
    return renderGlobal();
  };

  // The server sub-menu belongs to server pages only: on Dashboard/Servers/Account the
  // sidebar must fall back to the global navigation.
  const shellServer = segments[0] === "servers" && serverId ? detail.data?.server ?? null : null;

  return (
    <Shell server={shellServer} crumbs={crumbs}>
      {user.mustChangePassword ? (
        <Banner tone="warning" title="Your account still uses the bootstrap password">
          Change it in <Link to="/account" style={{ textDecoration: "underline" }}>My Profile</Link> before handing this panel to anyone else.
        </Banner>
      ) : null}
      {/* Keyed by pathname: every navigation gets a short, non-jarring enter transition. */}
      <div className="route-view" key={pathname}>
        {body()}
      </div>
    </Shell>
  );
}

export function Root() {
  return (
    <RouterProvider>
      <AppProvider>
        <App />
      </AppProvider>
    </RouterProvider>
  );
}

export type { UserPublic };

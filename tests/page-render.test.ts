import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

/*
 * Pages must survive their first render.
 *
 * `Cannot access 'form' before initialization` was a temporal-dead-zone crash in the Create Server
 * page: it read `form` above the `useState` that created it, so the very first render threw, React
 * unmounted the tree and the panel showed a black screen — the bug only became visible once someone
 * actually opened the wizard. `tsc` cannot see it (the read happens inside a callback) and the
 * production bundle builds happily, so the only honest guard is to render the pages for real.
 *
 * This runs the pages in happy-dom with a stubbed API: real components, real hooks, real render.
 */

let container: any;
let root: ReturnType<typeof import("react-dom/client").createRoot> | null = null;

const router = (path: string) => `http://localhost${path}`;

/** Canned answers for the handful of endpoints these pages touch on mount. */
const RESPONSES: Record<string, unknown> = {
  "/api/auth/me": {
    user: {
      id: 1, username: "admin", email: null, isRoot: true, mustChangePassword: false,
      totpEnabled: false, disabled: false, roles: ["Administrator"], permissions: ["*"],
      createdAt: "2026-01-01T00:00:00.000Z", lastLoginAt: null, avatarColor: "#1f6f4a",
      avatarUrl: null, theme: "neobrutalism",
    },
    csrfToken: "test-csrf",
    unreadNotifications: 0,
    securityNotice: null,
  },
  "/api/setup/status": { needsSetup: false, mode: "development", version: "2026.10.31.3", port: 3986, checks: [] },
  "/api/system/host": { cpuCores: 2, memoryTotalBytes: 2 * 1024 ** 3 },
  "/api/software": {
    data: [
      {
        id: "paper", label: "Paper", description: "High-performance fork", icon: "paper",
        supportsPlugins: true, supportsMods: false, needsInstaller: false, versionSource: "paper",
        javaMajors: [21], recommendedJava: 21,
      },
    ],
  },
  "/api/nodes": {
    data: [{ id: 1, name: "Local Node", fqdn: "127.0.0.1", isLocal: true, maintenance: false, online: true }],
  },
  "/api/users": { data: [{ id: 1, username: "admin" }] },
  "/api/servers": { data: [] },
  "/api/servers/count": { data: [] },
  "/api/notifications": { data: [], unread: 0 },
  "/api/software/paper/versions": {
    data: [{ id: "1.21.4", javaMajor: 21, experimental: false, label: "1.21.4", releasedAt: null }],
  },
  "/api/allocations/free": { data: [] },
  "/api/themes": { data: [] },
};

beforeAll(async () => {
  const window = new Window({ url: "http://localhost/servers/new" });
  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "CustomEvent", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage", "Headers", "Request", "Response", "FormData", "Blob", "File", "DOMParser"]) {
    // Bun already provides some of these; only fill in what is missing so the runtime stays stable.
    if (g[key] === undefined) g[key] = (window as unknown as Record<string, unknown>)[key];
  }
  g.IS_REACT_ACT_ENVIRONMENT = true;

  g.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(url, "http://localhost").pathname;
    const body = RESPONSES[path] ?? { data: [] };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", "x-rslmc-version": "2026.10.31.3" },
    });
  }) as typeof fetch;

  container = window.document.createElement("div") as any;
  window.document.body.appendChild(container);
  g.document = window.document as any;
});

afterAll(async () => {
  if (root) await (await import("react")).act(async () => root!.unmount());
});

/** Renders a page inside the real providers; throws (fails the test) if React reports an error. */
async function renderPage(element: React.ReactElement) {
  const { createRoot } = await import("react-dom/client");
  const React = await import("react");
  const { RouterProvider } = await import("../frontend/lib/router");
  const { AppProvider } = await import("../frontend/lib/app");

  const errors: unknown[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };

  try {
    if (root) await React.act(async () => root!.unmount());
    root = createRoot(container);
    await React.act(async () => {
      root!.render(
        React.createElement(
          RouterProvider,
          null,
          React.createElement(AppProvider, null, element),
        ),
      );
    });
    // Let the on-mount API calls settle: the crash in Create Server happened on the second pass.
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
  } finally {
    console.error = consoleError;
  }

  return {
    errors,
    text: (container.textContent ?? "").replace(/\s+/g, " ").trim(),
    html: container.innerHTML,
  };
}

describe("pages render without throwing", () => {
  test("Create Server survives its first render", async () => {
    const { CreateServerPage } = await import("../frontend/pages/CreateServer");
    const React = await import("react");
    const result = await renderPage(React.createElement(CreateServerPage));
    expect(result.text.length).toBeGreaterThan(20);
    // The wizard renders a step list and the first step's fields.
    expect(result.text.toLowerCase()).toContain("server name");
    expect(result.html).toContain("class=");
  });

  test("Dashboard and My Profile render as well", async () => {
    const { DashboardPage } = await import("../frontend/pages/Dashboard");
    const React = await import("react");
    const first = await renderPage(React.createElement(DashboardPage));
    expect(first.text.length).toBeGreaterThan(10);

    const { AccountPage } = await import("../frontend/pages/Account");
    const second = await renderPage(React.createElement(AccountPage));
    expect(second.text.toLowerCase()).toContain("themes");
  });
});

describe("no hook value is read before it exists", () => {
  /*
   * A second, cheaper guard for the same class of bug: a `const` initialiser that reads a hook value
   * declared further down the component is either dead code or a crash. Reading a hook inside
   * `useEffect` / `useMemo` / a callback is fine, so only initialiser lines are checked.
   */
  const files = ["frontend/pages/CreateServer.tsx", "frontend/pages/Dashboard.tsx", "frontend/pages/Account.tsx"];

  test("hook values are declared before they are used in a const initialiser", async () => {
    const hookDecl = /^\s*const\s*(?:\[(\w+)[,\]]|(\w+)\s*=\s*(?:useMemo|useCallback|useRef|useState))/;
    for (const file of files) {
      const lines = (await Bun.file(file).text()).split("\n");
      const declaredAt = new Map<string, number>();
      lines.forEach((line, index) => {
        const match = hookDecl.exec(line);
        const name = match?.[1] ?? match?.[2];
        if (name && !declaredAt.has(name)) declaredAt.set(name, index);
      });

      lines.forEach((line, index) => {
        if (!/^\s{2}(?:const|let)\s+\w+\s*=/.test(line)) return;      // only render-time initialisers
        if (/use(?:State|Memo|Callback|Ref|Effect)\(/.test(line)) return;
        for (const [name, declared] of declaredAt) {
          if (declared <= index) continue;
          const used = new RegExp(`(?<![\\w.])${name}(?![\\w])`).test(line);
          if (used) {
            throw new Error(`${file}:${index + 1} reads '${name}' before it is declared on line ${declared + 1}`);
          }
        }
      });
    }
  });
});

describe("a page that throws no longer blanks the panel", () => {
  /* React unmounts the whole tree when a render throws. The boundary is what kept the operator
     staring at an empty black window after the Create Server crash, so it is tested directly. */
  test("the error boundary shows the message and keeps the rest of the tree", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { ErrorBoundary } = await import("../frontend/components/error-boundary");

    const Boom = (): React.ReactElement => {
      throw new ReferenceError("Cannot access 'form' before initialization");
    };
    const consoleError = console.error;
    console.error = () => {};
    const host = (globalThis as any).document.createElement("div");
    (globalThis as any).document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await React.act(async () => {
        root.render(
          React.createElement(
            React.Fragment,
            null,
            React.createElement("nav", { id: "sidebar" }, "shell still here"),
            React.createElement(ErrorBoundary as any, { where: "servers / new" }, React.createElement(Boom)),
          ),
        );
      });
    } finally {
      console.error = consoleError;
    }
    const text = host.textContent.replace(/\s+/g, " ");
    expect(text).toContain("shell still here");                     // the panel survives
    expect(text).toContain("This page could not be drawn");
    expect(text).toContain("Cannot access 'form' before initialization");   // the real cause
    expect(text).toContain("servers / new");                        // which page failed
    await React.act(async () => root.unmount());
  });
});

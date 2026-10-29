import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { api, ApiError, setCsrfToken, errorMessage } from "./api";
import { applyStoredTheme, syncThemeForUser } from "./theme";
import type { UserPublic } from "../../src/shared/types";

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

export interface Toast {
  id: number;
  title: string;
  description?: string;
  tone: "info" | "success" | "warning" | "error";
}

interface ToastContextValue {
  toasts: Toast[];
  push: (toast: Omit<Toast, "id">) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue>({ toasts: [], push: () => {}, dismiss: () => {} });

function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback((toast: Omit<Toast, "id">) => {
    const id = ++counter.current;
    setToasts((current) => [...current.slice(-3), { ...toast, id }]);
    const timeout = toast.tone === "error" ? 9000 : 5000;
    setTimeout(() => dismiss(id), timeout);
  }, [dismiss]);

  const value = useMemo(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" role="region" aria-label="Notifications">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone}`} role="status">
            <div className="body">
              <b>{toast.title}</b>
              {toast.description ? <span>{toast.description}</span> : null}
            </div>
            <button className="x" onClick={() => dismiss(toast.id)} aria-label="Dismiss notification">✕</button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const { push } = useContext(ToastContext);
  return {
    notify: push,
    success: (title: string, description?: string) => push({ title, description, tone: "success" }),
    error: (title: string, description?: string) => push({ title, description, tone: "error" }),
    info: (title: string, description?: string) => push({ title, description, tone: "info" }),
    warn: (title: string, description?: string) => push({ title, description, tone: "warning" }),
    fromError: (error: unknown, fallback = "Something went wrong") =>
      push({ title: fallback, description: errorMessage(error), tone: "error" }),
  };
}

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

interface SessionValue {
  user: UserPublic | null;
  loading: boolean;
  securityNotice: string | null;
  unreadNotifications: number;
  login: (username: string, password: string, totp?: string) => Promise<{ requiresTotp?: boolean }>;
  setTheme: (theme: string) => Promise<string>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  setUnread: Dispatch<SetStateAction<number>>;
  can: (permission: string | string[]) => boolean;
  clearSecurityNotice: () => void;
}

const SessionContext = createContext<SessionValue>({
  user: null, loading: true, securityNotice: null, unreadNotifications: 0,
  login: async () => ({}), logout: async () => {}, refresh: async () => {}, setTheme: async (theme: string) => theme,
  setUnread: () => {}, can: () => false, clearSecurityNotice: () => {},
});

export function AppProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserPublic | null>(null);
  const [loading, setLoading] = useState(true);
  const [securityNotice, setSecurityNotice] = useState<string | null>(null);
  const [unreadNotifications, setUnread] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const data = await api.get<{ user: UserPublic; unreadNotifications: number; csrfToken: string | null }>("/api/auth/me");
      if (data.csrfToken) setCsrfToken(data.csrfToken);
      setUser(data.user);
      setUnread(data.unreadNotifications);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  /*
   * Paint the palette before the first request (localStorage mirror), then let the account win once
   * it answers — a theme set on another device arrives with the session.
   */
  useEffect(() => { applyStoredTheme(); }, []);
  useEffect(() => { syncThemeForUser(user?.theme); }, [user?.theme]);

  const login = useCallback(async (username: string, password: string, totp?: string) => {
    const data = await api.post<{ user: UserPublic; csrfToken: string; securityNotice: string | null }>("/api/auth/login", {
      username, password, totp,
    });
    /*
     * The password was accepted — but the session only exists if the browser stored the session
     * cookie. When it does not (Secure cookie handed out over plain HTTP, cookies blocked for this
     * site, ...) every later request returns 401 and the page bounces back to /login forever.
     * Verify the cookie round-trip here and say what is actually wrong instead of looping.
     */
    const persisted = await api.get<{ user: UserPublic }>("/api/auth/me").then(() => true).catch(() => false);
    if (!persisted) {
      throw new ApiError(
        401,
        "session_not_stored",
        "Signed in, but this browser did not keep the session cookie — so the panel cannot stay logged in. "
        + "Serve RSLMC over HTTPS, or set RSLMC_COOKIE_SECURE=never when the panel is reachable only over plain HTTP. "
        + "Also make sure cookies are allowed for this site (private windows and strict third-party cookie blockers can drop them).",
      );
    }
    setCsrfToken(data.csrfToken);
    setUser(data.user);
    setSecurityNotice(data.securityNotice);
    setUnread(1);
    return {};
  }, []);

  const logout = useCallback(async () => {
    try { await api.post("/api/auth/logout"); } catch { /* ignore */ }
    setCsrfToken(null);
    setUser(null);
    window.history.replaceState({}, "", "/login");
    window.location.reload();
  }, []);

  /** Applies a theme immediately and remembers it on the account. */
  const setTheme = useCallback(async (theme: string) => {
    syncThemeForUser(theme);
    const data = await api.patch<{ user: UserPublic }>("/api/auth/preferences", { theme });
    setUser(data.user);
    syncThemeForUser(data.user.theme);
    return data.user.theme;
  }, []);

  const can = useCallback((permission: string | string[]) => {
    if (!user) return false;
    if (user.isRoot || user.permissions.includes("*")) return true;
    const needed = Array.isArray(permission) ? permission : [permission];
    return needed.some((entry) => user.permissions.includes(entry));
  }, [user]);

  const value = useMemo<SessionValue>(() => ({
    user, loading, securityNotice, unreadNotifications, login, logout, refresh, setUnread, can, setTheme,
    clearSecurityNotice: () => setSecurityNotice(null),
  }), [user, loading, securityNotice, unreadNotifications, login, logout, refresh, can, setTheme]);

  return (
    <ToastProvider>
      <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
    </ToastProvider>
  );
}

export function useSession(): SessionValue {
  return useContext(SessionContext);
}

/* ------------------------------------------------------------------ */
/* Data loading helper                                                 */
/* ------------------------------------------------------------------ */

export function useApi<T>(path: string | null, deps: unknown[] = []): {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!path) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    api.get<T>(path)
      .then((result) => { if (!cancelled) { setData(result); setError(null); } })
      .catch((err) => { if (!cancelled) setError(errorMessage(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce, ...deps]);

  return { data, error, loading, reload: () => setNonce((value) => value + 1) };
}

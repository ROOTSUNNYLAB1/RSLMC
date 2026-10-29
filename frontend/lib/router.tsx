import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

interface RouterValue {
  path: string;
  navigate: (to: string, opts?: { replace?: boolean }) => void;
}

const RouterContext = createContext<RouterValue>({ path: "/", navigate: () => {} });

export function RouterProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(() => window.location.pathname + window.location.search);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname + window.location.search);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((to: string, opts: { replace?: boolean } = {}) => {
    if (to === window.location.pathname + window.location.search) return;
    if (opts.replace) window.history.replaceState({}, "", to);
    else window.history.pushState({}, "", to);
    setPath(to);
    window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  const value = useMemo(() => ({ path, navigate }), [path, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  return useContext(RouterContext);
}

export function Link({
  to, children, className, onClick, ...rest
}: { to: string; children: ReactNode; className?: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const { navigate } = useRouter();
  return (
    <a
      {...rest}
      href={to}
      className={className}
      onClick={(event) => {
        // Consumer handlers (e.g. closing the mobile drawer) run first and may cancel.
        onClick?.(event);
        if (event.defaultPrevented) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

/** Matches `/servers/:id/<page>` style routes without a router dependency. */
export function matchRoute(path: string): { segments: string[]; query: URLSearchParams } {
  const [pathname, search] = path.split("?");
  return {
    segments: (pathname ?? "/").split("/").filter(Boolean),
    query: new URLSearchParams(search ?? ""),
  };
}

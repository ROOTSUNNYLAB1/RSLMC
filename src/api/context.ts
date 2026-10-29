import { parseCookies } from "../shared/http";
import { TRUST_PROXY } from "../shared/config";
import type { RequestContext } from "../shared/http";

export function clientIp(req: Request): string {
  if (TRUST_PROXY) {
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) return forwarded.split(",")[0]!.trim();
  }
  const direct = req.headers.get("x-real-ip");
  if (direct) return direct;
  // Bun.serve provides the socket address through server.requestIP; the wrapper sets this header.
  return req.headers.get("x-rslmc-client-ip") ?? "unknown";
}

export function buildContext(req: Request, url: URL, params: Record<string, string>, cookiesHeader?: string | null): RequestContext {
  const cookies = parseCookies(cookiesHeader ?? req.headers.get("cookie"));
  const cookieJar: string[] = [];
  return {
    req,
    url,
    params,
    headers: req.headers,
    clientIp: clientIp(req),
    cookies,
    async body<T = any>(): Promise<T> {
      const contentType = req.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        try {
          return (await req.json()) as T;
        } catch {
          const { badRequest } = await import("../shared/http");
          throw badRequest("Request body is not valid JSON");
        }
      }
      return {} as T;
    },
    query(key: string) {
      return url.searchParams.get(key);
    },
    setCookie(cookie: string) {
      cookieJar.push(cookie);
    },
  };
}

export function collectCookies(context: RequestContext, response: Response): Response {
  const header = context.req.headers.get("x-rslmc-set-cookie-done");
  return response;
}

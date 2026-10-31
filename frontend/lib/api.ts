/** Typed API client: attaches the CSRF token, unwraps errors, never caches. */
export interface ApiErrorShape { code: string; message: string; details?: unknown }

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let csrfToken: string | null = null;

/*
 * The panel stamps every API response with `x-rslmc-version`. Reading it here means the UI can show
 * the version it is actually talking to instead of a number someone typed into the source. That is
 * exactly how the dashboard ended up claiming a placeholder build while the panel reported a much
 * newer one in its own activity feed.
 */
let panelVersion: string | null = null;

export function getPanelVersion(): string | null {
  return panelVersion;
}

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

async function request<T>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const isBinary = body instanceof Blob;
  if (body !== undefined && !isBinary && !(body instanceof FormData)) headers.set("content-type", "application/json");
  if (isBinary) headers.set("content-type", (body as Blob).type || "application/octet-stream");
  if (csrfToken && !["GET", "HEAD"].includes(method)) headers.set("x-csrf-token", csrfToken);

  const response = await fetch(path, {
    method,
    headers,
    body: isBinary || body instanceof FormData ? (body as BodyInit) : body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
    ...init,
  });

  const stamped = response.headers.get("x-rslmc-version");
  if (stamped) panelVersion = stamped;

  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok) {
    let payload: { error?: ApiErrorShape } = {};
    if (contentType.includes("application/json")) {
      try { payload = await response.json(); } catch { /* ignore */ }
    }
    throw new ApiError(
      response.status,
      payload.error?.code ?? "request_failed",
      payload.error?.message ?? `Request failed with HTTP ${response.status}`,
      payload.error?.details,
    );
  }
  if (response.status === 204) return undefined as T;
  if (contentType.includes("application/json")) return (await response.json()) as T;
  return (await response.text()) as unknown as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  delete: <T>(path: string, body?: unknown) => request<T>("DELETE", path, body),
  upload: <T>(path: string, form: FormData) => request<T>("POST", path, form),
  /** Raw-bytes upload (profile pictures): the body is the image itself, nothing is re-encoded. */
  postBlob: <T>(path: string, blob: Blob) => request<T>("POST", path, blob),
  raw: request,
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.details && typeof error.details === "object" && !Array.isArray(error.details)) {
      const details = Object.entries(error.details as Record<string, string>)
        .map(([field, message]) => `${field}: ${message}`)
        .join(" · ");
      if (details) return `${error.message} — ${details}`;
    }
    if (Array.isArray(error.details) && error.details.length > 0) {
      return `${error.message} — ${error.details.join(" ")}`;
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

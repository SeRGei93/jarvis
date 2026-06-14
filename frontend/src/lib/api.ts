import WebApp from "@twa-dev/sdk";

/**
 * Typed admin API client. All calls are same-origin to `/admin/api/...`
 * (the Vite dev proxy forwards them to the backend on :8080; in prod the
 * Mini App is served by the backend itself). Every request carries the raw
 * Telegram initData as `Authorization: tma <initData>` — the backend verifies
 * the HMAC and admin allowlist on each request.
 */

/** Same-origin base; the dev proxy / prod static host resolves `/admin/api`. */
const API_BASE = "/admin/api";

/** Error thrown for any non-2xx admin API response. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }

  /** True for auth failures (missing/invalid initData → 401, not admin → 403). */
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** True when the error means "no access" (auth failure). Use for the AccessDenied gate. */
export function isAccessDenied(err: unknown): boolean {
  return err instanceof ApiError && err.isAuth;
}

function authHeaders(): HeadersInit {
  // Raw initData string from the Telegram WebApp SDK. Empty when opened
  // outside Telegram — the backend will then 401, surfacing AccessDenied.
  return { Authorization: `tma ${WebApp.initData}` };
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { ...(authHeaders() as Record<string, string>) };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, init);
  } catch (e) {
    throw new ApiError(0, e instanceof Error ? e.message : "network error");
  }

  if (!res.ok) {
    // Backend error responses are `{ error: string }`; fall back to status text.
    let message = res.statusText;
    try {
      const data = (await res.json()) as { error?: string };
      if (data && typeof data.error === "string") message = data.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message);
  }

  // 204 / empty body → undefined.
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>("GET", path);
}
export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>("POST", path, body);
}
export function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return request<T>("PUT", path, body);
}
export function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return request<T>("PATCH", path, body);
}
export function apiDelete<T>(path: string): Promise<T> {
  return request<T>("DELETE", path);
}

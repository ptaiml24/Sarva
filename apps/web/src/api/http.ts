/** Relative `/api` works with Vite dev proxy and same-origin production. */
/** Emitted so `AuthProvider` can clear React auth state when the API rejects the session. */
export const SARVA_SESSION_INVALID_EVENT = "sarva:session-invalid";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function getToken(): string | null {
  return sessionStorage.getItem("sarva_token");
}

export function setToken(token: string | null): void {
  if (token) sessionStorage.setItem("sarva_token", token);
  else sessionStorage.removeItem("sarva_token");
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.json !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const body = init?.json !== undefined ? JSON.stringify(init.json) : init?.body;

  let r: Response;
  try {
    r = await fetch(path, { ...init, headers, body });
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    const looksLikeDroppedWhileWaiting =
      /failed to fetch|load failed|networkerror|aborted|reset|econnreset/i.test(cause);
    const hint =
      path.startsWith("/api") ?
        looksLikeDroppedWhileWaiting ?
          "Cannot reach API or connection closed early. If a slow LLM call was running, retry after `npm run dev:web` (proxy timeouts disabled). Otherwise start the API: `npm run dev:api` (port 3000) and open the app only via Vite (`npm run dev:web` / `npm run e2e:serve`), not `vite preview` or static `dist/` — those do not proxy `/api`. Use http://127.0.0.1:5173 or http://localhost:5173 after the host fix."
        : "Cannot reach API. From the repo root run `npm run dev:api` (port 3000) and `npm run dev:web` so `/api` is proxied. Do not open the built `dist/` or `vite preview` unless the API is same-origin."
      : "Network request failed.";
    throw new Error(`${hint} (${cause})`);
  }
  const text = await r.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }

  if (!r.ok) {
    if (r.status === 401 && !path.includes("/api/v1/auth/login")) {
      window.dispatchEvent(new Event(SARVA_SESSION_INVALID_EVENT));
    }
    const msg =
      typeof parsed === "object" && parsed !== null && "message" in parsed
        ? String((parsed as { message: unknown }).message)
        : typeof parsed === "object" && parsed !== null && "error" in parsed
          ? String((parsed as { error: { message?: string } }).error?.message ?? r.statusText)
          : text || r.statusText;
    throw new ApiError(msg, r.status, parsed);
  }

  return parsed as T;
}

/**
 * Gemini / Vertex and other clouds often respond 429 RESOURCE_EXHAUSTED on quota or short spikes.
 * A few bounded retries absorb brief throttling without hammering the provider.
 */

const RETRY_STATUSES = new Set([429, 503]);
/** initial request + retries */
const DEFAULT_MAX_ATTEMPTS = 4;
const MAX_DELAY_MS = 30_000;

function parseRetryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  const asInt = parseInt(trimmed, 10);
  if (/^\d+$/.test(trimmed) && Number.isFinite(asInt) && asInt >= 0) {
    return Math.min(asInt * 1000, MAX_DELAY_MS);
  }
  const at = Date.parse(trimmed);
  if (!Number.isNaN(at)) {
    const delta = at - Date.now();
    return delta > 0 ? Math.min(delta, MAX_DELAY_MS) : 0;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Executes `fetch`; on 429 / 503, drains the body and waits before retrying.
 * Returns the last response when non-retryable or attempts are exhausted (body unread).
 */
export async function fetchWithRateLimitRetry(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  options?: { maxAttempts?: number }
): Promise<Response> {
  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let last: Response | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(input, init);
    last = res;
    const canRetry = RETRY_STATUSES.has(res.status) && attempt < maxAttempts - 1;
    if (!canRetry) {
      return res;
    }

    const fromHeader =
      parseRetryAfterMs(res.headers.get("retry-after")) ??
      parseRetryAfterMs(res.headers.get("Retry-After"));
    const backoff = Math.min(MAX_DELAY_MS, 1000 * 2 ** attempt);
    const waitMs = fromHeader !== null ? Math.max(fromHeader, 0) : backoff;

    try {
      await res.arrayBuffer();
    } catch {
      /* ignore drain errors */
    }
    await sleep(waitMs);
  }

  return last as Response;
}

/** User-facing clarification when providers return quota / overload errors */
export function formatLlmHttpError(errorLabel: string, status: number, bodyText: string): string {
  const snippet = bodyText.trim().slice(0, 800);
  let msg = `${errorLabel}: ${status} ${snippet}`;
  const upper = snippet.toUpperCase();
  if (status === 429 || status === 503 || upper.includes("RESOURCE_EXHAUSTED")) {
    msg +=
      "\n\nRate limit or quota exhausted (often temporary). Retry after a short wait; use a lighter or higher-quota model; reduce parallel LLM usage; verify Vertex AI/Gemini quotas in Google Cloud Console. See https://cloud.google.com/vertex-ai/generative-ai/docs/error-code-429 when using Vertex.";
  }
  return msg;
}

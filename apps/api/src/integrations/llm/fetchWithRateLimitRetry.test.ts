import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchWithRateLimitRetry, formatLlmHttpError } from "./fetchWithRateLimitRetry.js";

function jsonResponse(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return new Response(text, { status, headers: { "Content-Type": "application/json" } });
}

describe("fetchWithRateLimitRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("retries on 429 then returns success", async () => {
    const ok = jsonResponse(200, { ok: true });
    const tooMany = jsonResponse(429, { error: "slow down" });
    const fetchMock = vi.fn().mockResolvedValueOnce(tooMany).mockResolvedValueOnce(ok);
    vi.stubGlobal("fetch", fetchMock);

    const p = fetchWithRateLimitRetry("https://example.test/llm", { method: "POST" });
    await vi.advanceTimersByTimeAsync(1000);
    const res = await p;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });

  it("returns last response after exhausting attempts on persistent 429", async () => {
    const tooMany = jsonResponse(429, { error: "quota" });
    const fetchMock = vi.fn().mockResolvedValue(tooMany);
    vi.stubGlobal("fetch", fetchMock);

    const p = fetchWithRateLimitRetry("https://example.test/llm", { method: "POST" }, { maxAttempts: 2 });
    await vi.advanceTimersByTimeAsync(120_000);

    const res = await p;
    expect(res.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("formatLlmHttpError", () => {
  it("appends quota guidance for RESOURCE_EXHAUSTED", () => {
    const body = JSON.stringify({
      error: { code: 429, message: "Resource exhausted.", status: "RESOURCE_EXHAUSTED" },
    });
    const msg = formatLlmHttpError("Board planning LLM failed", 429, body);
    expect(msg).toContain("Board planning LLM failed");
    expect(msg).toContain("quota");
    expect(msg).toContain("cloud.google.com/vertex-ai/generative-ai/docs/error-code-429");
  });
});

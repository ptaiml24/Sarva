import { describe, it, expect } from "vitest";
import { isLlmQuotaOrOverloadFailure } from "./pmOrchestrator.js";
import { formatLlmHttpError } from "./llm/fetchWithRateLimitRetry.js";

describe("isLlmQuotaOrOverloadFailure", () => {
  it("detects Vertex-style RESOURCE_EXHAUSTED payloads", () => {
    const body = JSON.stringify({
      error: { code: 429, message: "Resource exhausted.", status: "RESOURCE_EXHAUSTED" },
    });
    const err = new Error(formatLlmHttpError("Board planning LLM failed", 429, body));
    expect(isLlmQuotaOrOverloadFailure(err)).toBe(true);
  });

  it("returns false for malformed planner JSON failures", () => {
    expect(isLlmQuotaOrOverloadFailure(new Error("Board planner returned invalid JSON: unexpected"))).toBe(false);
  });
});

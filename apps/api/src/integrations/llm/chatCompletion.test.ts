import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateAssistantText } from "./chatCompletion.js";
import { generatePrdMarkdownWithLlm } from "../prdLlm.js";

function mockGeminiResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => payload,
  } as unknown as Response;
}

describe("generateAssistantText — Google Gemini", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockGeminiResponse({
          candidates: [{ content: { parts: [{ text: "## PRD section\nBody." }] } }],
        })
      )
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to generativelanguage.googleapis.com generateContent with key query and merged prompt", async () => {
    const fetchMock = vi.mocked(fetch);

    const out = await generateAssistantText({
      cred: {
        provider: "google",
        modelId: "gemini-2.0-flash",
        apiKey: "ai-studio-test-key",
        baseUrl: null,
      },
      systemPrompt: "System instructions.",
      userPrompt: "User ask.",
      temperature: 0.35,
      errorLabel: "test-label",
    });

    expect(out).toBe("## PRD section\nBody.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toMatch(/generativelanguage\.googleapis\.com\/v1beta\/models\//);
    expect(String(url)).toContain(encodeURIComponent("gemini-2.0-flash"));
    expect(String(url)).toContain(":generateContent");
    expect(String(url)).toContain("key=" + encodeURIComponent("ai-studio-test-key"));
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as {
      contents: { role: string; parts: { text: string }[] }[];
      generationConfig: { temperature: number };
    };
    expect(body.generationConfig.temperature).toBe(0.35);
    expect(body.contents[0].role).toBe("user");
    expect(body.contents[0].parts[0].text).toContain("System instructions.");
    expect(body.contents[0].parts[0].text).toContain("User ask.");
  });

  it("appends JSON-only suffix when jsonObjectMode for Google", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      mockGeminiResponse({
        candidates: [{ content: { parts: [{ text: '{"updates":[],"newTasks":[]}' }] } }],
      })
    );

    await generateAssistantText({
      cred: { provider: "google", modelId: "gemini-2.0-flash", apiKey: "k", baseUrl: null },
      systemPrompt: "Board plan system",
      userPrompt: "tasks...",
      temperature: 0.2,
      jsonObjectMode: true,
      errorLabel: "board",
    });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as { contents: { parts: { text: string }[] }[] };
    expect(body.contents[0].parts[0].text).toMatch(/valid JSON object only/);
    expect(body.contents[0].parts[0].text).toContain("Board plan system");
  });
});

describe("generatePrdMarkdownWithLlm with Google cred (integration of PRD → chatCompletion)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockGeminiResponse({
          candidates: [{ content: { parts: [{ text: "# PRD\nOK" }] } }],
        })
      )
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses Gemini generateContent path for PRD when provider is google", async () => {
    const fetchMock = vi.mocked(fetch);
    const md = await generatePrdMarkdownWithLlm(
      "Project context",
      { provider: "google", modelId: "gemini-1.5-pro", apiKey: "binding-key", baseUrl: null },
      undefined
    );
    expect(md).toBe("# PRD\nOK");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("generativelanguage.googleapis.com");
    expect(url).toContain("gemini-1.5-pro");
  });
});

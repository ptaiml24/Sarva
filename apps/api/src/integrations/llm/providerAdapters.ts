/**
 * One adapter per major provider family; keeps HTTP shapes and env fallbacks in one place.
 */
import { PM_BACKLOG_JSON_SYSTEM } from "../../prompt/pm-prompts.js";
import { extractJsonArray, normalizeBacklogItems, type NormalizedBacklogLine } from "./jsonBacklog.js";
import { openAiCompatibleChatCompletionsUrl } from "./openAiCompatUrl.js";
import { resolveEffectiveApiKey } from "./resolveApiKey.js";
import type { ResolvedLlmCredentials } from "./types.js";

type AdapterContext = {
  userPrompt: string;
  cred: ResolvedLlmCredentials;
  fallbackOpenAiEnvKey: string | undefined;
};

type AdapterFn = (ctx: AdapterContext) => Promise<NormalizedBacklogLine[]>;

function chatCompletionsOpenAiCompatible(
  ctx: AdapterContext,
  opts: { requireKey: boolean; defaultBase: string }
): Promise<NormalizedBacklogLine[]> {
  const { cred, userPrompt, fallbackOpenAiEnvKey } = ctx;
  const p = cred.provider.toLowerCase();
  const key = resolveEffectiveApiKey(cred, fallbackOpenAiEnvKey);
  const base =
    cred.baseUrl?.trim() ||
    (p === "ollama" ? process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434" : "") ||
    (p === "meta" ? process.env.LLAMA_API_URL?.trim() || "" : "") ||
    opts.defaultBase;
  const url = openAiCompatibleChatCompletionsUrl(base);
  if (opts.requireKey && !key) {
    throw new Error(
      "API key is required for this provider (save it on the provider connection or set the matching env var for legacy)."
    );
  }
  return (async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: cred.modelId,
        temperature: 0.3,
        messages: [
          { role: "system", content: PM_BACKLOG_JSON_SYSTEM },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`LLM request failed: ${res.status} ${t.slice(0, 500)}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = data.choices?.[0]?.message?.content?.trim() ?? "";
    return normalizeBacklogItems(extractJsonArray(raw));
  })();
}

const adapters: Record<string, AdapterFn> = {
  openai: (ctx) =>
    chatCompletionsOpenAiCompatible(ctx, { requireKey: true, defaultBase: "https://api.openai.com/v1" }),

  ollama: (ctx) =>
    chatCompletionsOpenAiCompatible(ctx, { requireKey: false, defaultBase: "http://127.0.0.1:11434" }),

  meta: (ctx) => chatCompletionsOpenAiCompatible(ctx, { requireKey: true, defaultBase: "https://api.openai.com/v1" }),

  anthropic: async (ctx) => {
    const key = resolveEffectiveApiKey(ctx.cred, ctx.fallbackOpenAiEnvKey);
    if (!key) throw new Error("ANTHROPIC_API_KEY or connection api key required");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ctx.cred.modelId,
        max_tokens: 4096,
        system: PM_BACKLOG_JSON_SYSTEM,
        messages: [{ role: "user", content: ctx.userPrompt }],
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Anthropic failed: ${res.status} ${t.slice(0, 500)}`);
    }
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = data.content?.find((c) => c.type === "text")?.text ?? "";
    return normalizeBacklogItems(extractJsonArray(text.trim()));
  },

  google: async (ctx) => {
    const key = resolveEffectiveApiKey(ctx.cred, ctx.fallbackOpenAiEnvKey);
    if (!key) throw new Error("GOOGLE_GENERATIVE_AI_API_KEY or connection api key required");
    const mid = encodeURIComponent(ctx.cred.modelId);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${mid}:generateContent?key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `${PM_BACKLOG_JSON_SYSTEM}\n\n${ctx.userPrompt}` }] }],
        generationConfig: { temperature: 0.3 },
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Gemini failed: ${res.status} ${t.slice(0, 500)}`);
    }
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const raw =
      data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    return normalizeBacklogItems(extractJsonArray(raw.trim()));
  },

  /** Cursor Cloud Agents / local agent via `@cursor/sdk` (see LLM catalog). */
  cursor: async (ctx) => {
    const key = resolveEffectiveApiKey(ctx.cred, ctx.fallbackOpenAiEnvKey);
    if (!key) throw new Error("CURSOR_API_KEY or connection api key required");
    const { cursorAgentPromptText } = await import("./cursorSdkPrompt.js");
    const system =
      PM_BACKLOG_JSON_SYSTEM +
      "\n\nRespond with a single valid JSON array only (the backlog objects). No markdown fences or prose outside the JSON.";
    const raw = await cursorAgentPromptText({
      cred: ctx.cred,
      systemPrompt: system,
      userPrompt: ctx.userPrompt,
      errorLabel: "Cursor backlog LLM failed",
      apiKey: key,
    });
    return normalizeBacklogItems(extractJsonArray(raw.trim()));
  },
};

export function generateBacklogViaProviderAdapter(
  userPrompt: string,
  cred: ResolvedLlmCredentials,
  fallbackOpenAiEnvKey: string | undefined
): Promise<NormalizedBacklogLine[]> {
  const id = cred.provider.toLowerCase();
  const fn = adapters[id];
  if (!fn) {
    throw new Error(`Unsupported provider: ${cred.provider}`);
  }
  return fn({ userPrompt, cred, fallbackOpenAiEnvKey });
}

import { openAiCompatibleChatCompletionsUrl } from "./openAiCompatUrl.js";
import { fetchWithRateLimitRetry, formatLlmHttpError } from "./fetchWithRateLimitRetry.js";
import { resolveEffectiveApiKey } from "./resolveApiKey.js";
import type { ResolvedLlmCredentials } from "./types.js";

export type GenerateAssistantTextParams = {
  cred: ResolvedLlmCredentials;
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  /**
   * OpenAI: sets `response_format: { type: "json_object" }`.
   * Other providers: appends a strict JSON-only instruction to the system prompt (no native JSON mode).
   */
  jsonObjectMode?: boolean;
  fallbackOpenAiEnvKey?: string | undefined;
  /** Shown in thrown errors, e.g. "PRD LLM failed". */
  errorLabel: string;
  /**
   * Cursor provider, **local** mode only: SDK `local.cwd` (Sarva passes project dev workspace from coder run).
   * Falls back to `CURSOR_AGENT_LOCAL_CWD` then `process.cwd()` (often `apps/api`).
   */
  cursorLocalPreferredCwd?: string | null;
};

const JSON_ONLY_SUFFIX =
  "\n\nRespond with a single valid JSON object only. Do not wrap in markdown fences or add commentary outside the JSON.";

function openAiStyleBase(cred: ResolvedLlmCredentials, p: string): string {
  return (
    cred.baseUrl?.trim() ||
    (p === "ollama" ? process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434" : "") ||
    (p === "meta" ? process.env.LLAMA_API_URL?.trim() || "" : "") ||
    "https://api.openai.com/v1"
  );
}

async function viaOpenAiCompatibleChat(
  cred: ResolvedLlmCredentials,
  key: string | null,
  systemPrompt: string,
  userPrompt: string,
  temperature: number,
  jsonObjectMode: boolean,
  provider: string,
  errorLabel: string
): Promise<string> {
  const base = openAiStyleBase(cred, provider);
  const url = openAiCompatibleChatCompletionsUrl(base);
  if (provider !== "ollama" && !key) {
    throw new Error(`${errorLabel}: API key required (save on provider connection or set env).`);
  }

  const effectiveSystem =
    jsonObjectMode && provider !== "openai" ? systemPrompt + JSON_ONLY_SUFFIX : systemPrompt;
  const body: Record<string, unknown> = {
    model: cred.modelId,
    temperature,
    messages: [
      { role: "system", content: effectiveSystem },
      { role: "user", content: userPrompt },
    ],
  };
  if (jsonObjectMode && provider === "openai") {
    body.response_format = { type: "json_object" };
  }

  const res = await fetchWithRateLimitRetry(url, {
    method: "POST",
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(formatLlmHttpError(errorLabel, res.status, t));
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = data.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) {
    throw new Error(`${errorLabel}: empty response.`);
  }
  return text;
}

async function viaAnthropic(
  cred: ResolvedLlmCredentials,
  key: string,
  systemPrompt: string,
  userPrompt: string,
  temperature: number,
  jsonObjectMode: boolean,
  errorLabel: string
): Promise<string> {
  const sys = jsonObjectMode ? systemPrompt + JSON_ONLY_SUFFIX : systemPrompt;
  const res = await fetchWithRateLimitRetry("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: cred.modelId,
      max_tokens: 8192,
      temperature,
      system: sys,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(formatLlmHttpError(errorLabel, res.status, t));
  }
  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text =
    data.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("") ?? "";
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error(`${errorLabel}: empty response.`);
  }
  return trimmed;
}

async function viaGoogle(
  cred: ResolvedLlmCredentials,
  key: string,
  systemPrompt: string,
  userPrompt: string,
  temperature: number,
  jsonObjectMode: boolean,
  errorLabel: string
): Promise<string> {
  const sys = jsonObjectMode ? systemPrompt + JSON_ONLY_SUFFIX : systemPrompt;
  /** Single user turn avoids Gemini `systemInstruction` quirks across model generations. */
  const combined = `${sys}\n\n${userPrompt}`;
  const mid = encodeURIComponent(cred.modelId);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${mid}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetchWithRateLimitRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: combined }] }],
      generationConfig: { temperature },
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(formatLlmHttpError(errorLabel, res.status, t));
  }
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const raw = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`${errorLabel}: empty response.`);
  }
  return trimmed;
}

/**
 * One entry point for “system + user → assistant text” across supported providers.
 * Uses the binding’s `provider`, `modelId`, `apiKey`, and optional `baseUrl` (OpenAI-compatible hosts).
 */
export async function generateAssistantText(params: GenerateAssistantTextParams): Promise<string> {
  const {
    cred,
    systemPrompt,
    userPrompt,
    temperature,
    jsonObjectMode = false,
    fallbackOpenAiEnvKey,
    errorLabel,
    cursorLocalPreferredCwd,
  } = params;
  const p = cred.provider.toLowerCase();
  const key = resolveEffectiveApiKey(cred, fallbackOpenAiEnvKey);

  if (p === "openai" || p === "meta" || p === "ollama") {
    return viaOpenAiCompatibleChat(cred, key, systemPrompt, userPrompt, temperature, jsonObjectMode, p, errorLabel);
  }
  if (p === "anthropic") {
    if (!key) {
      throw new Error(`${errorLabel}: ANTHROPIC_API_KEY or connection api key required.`);
    }
    return viaAnthropic(cred, key, systemPrompt, userPrompt, temperature, jsonObjectMode, errorLabel);
  }
  if (p === "google") {
    if (!key) {
      throw new Error(`${errorLabel}: Google API key required on the connection or GOOGLE_GENERATIVE_AI_API_KEY.`);
    }
    return viaGoogle(cred, key, systemPrompt, userPrompt, temperature, jsonObjectMode, errorLabel);
  }
  if (p === "cursor") {
    if (!key) {
      throw new Error(`${errorLabel}: Cursor API key required on the connection or CURSOR_API_KEY in env.`);
    }
    const { cursorAgentPromptText } = await import("./cursorSdkPrompt.js");
    return cursorAgentPromptText({
      cred,
      systemPrompt: jsonObjectMode ? systemPrompt + JSON_ONLY_SUFFIX : systemPrompt,
      userPrompt,
      errorLabel,
      apiKey: key,
      preferredLocalCwd: cursorLocalPreferredCwd,
    });
  }
  throw new Error(`${errorLabel}: unsupported provider "${cred.provider}".`);
}

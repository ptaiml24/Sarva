import type { Env } from "../../config/env.js";
import { generateAssistantText } from "./chatCompletion.js";
import { resolveEffectiveApiKey } from "./resolveApiKey.js";
import type { ResolvedLlmCredentials } from "./types.js";

/** Upper bound for Admin "Test connection" — LLM calls can be slow; client should use a generous proxy timeout. */
export const LLM_CONNECTION_TEST_TIMEOUT_MS = 120_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Test timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function executeTest(
  cred: ResolvedLlmCredentials,
  env: Pick<Env, "OPENAI_API_KEY">
): Promise<string> {
  const p = cred.provider.toLowerCase();
  if (p === "cursor") {
    const key = resolveEffectiveApiKey(cred, env.OPENAI_API_KEY);
    if (!key) {
      throw new Error("Cursor API key required (save on connection or set CURSOR_API_KEY).");
    }
    const { Cursor } = await import("@cursor/sdk");
    const user = await Cursor.me({ apiKey: key });
    const who = user.userEmail ?? user.apiKeyName ?? "authenticated";
    return `Cursor API OK — ${who}`;
  }

  const key = resolveEffectiveApiKey(cred, env.OPENAI_API_KEY);
  if (p !== "ollama" && !key) {
    throw new Error("API key missing on connection and no matching env fallback.");
  }

  const text = await generateAssistantText({
    cred,
    systemPrompt:
      "You are a Sarva connectivity probe. Reply with one short line of plain text confirming the request was received. No tools, no code fences.",
    userPrompt: "ping",
    temperature: 0,
    errorLabel: "LLM test",
    fallbackOpenAiEnvKey: env.OPENAI_API_KEY,
  });
  const t = text.trim();
  if (!t) throw new Error("Model returned empty text.");
  return t.length > 200 ? `${t.slice(0, 197)}…` : t;
}

export async function testResolvedLlmCredentials(
  cred: ResolvedLlmCredentials,
  env: Pick<Env, "OPENAI_API_KEY">
): Promise<
  { ok: true; latencyMs: number; detail: string } | { ok: false; error: string; latencyMs: number }
> {
  const t0 = Date.now();
  try {
    const detail = await withTimeout(executeTest(cred, env), LLM_CONNECTION_TEST_TIMEOUT_MS);
    return { ok: true, latencyMs: Date.now() - t0, detail };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, latencyMs: Date.now() - t0 };
  }
}

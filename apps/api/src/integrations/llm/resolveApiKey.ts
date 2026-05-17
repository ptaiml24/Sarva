import type { ResolvedLlmCredentials } from "./types.js";

/**
 * Effective API key for outbound calls: connection first, then provider-specific env fallbacks.
 * Ollama typically has no key.
 */
export function resolveEffectiveApiKey(
  cred: ResolvedLlmCredentials,
  fallbackOpenAiEnvKey: string | undefined
): string | null {
  const trimmed = cred.apiKey?.trim();
  if (trimmed) return trimmed;
  const p = cred.provider.toLowerCase();
  if (p === "openai") return fallbackOpenAiEnvKey?.trim() || null;
  if (p === "meta") {
    return (
      process.env.LLAMA_API_KEY?.trim() ||
      fallbackOpenAiEnvKey?.trim() ||
      null
    );
  }
  if (p === "anthropic") return process.env.ANTHROPIC_API_KEY?.trim() || null;
  if (p === "google") {
    return (
      process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
      process.env.GOOGLE_AI_API_KEY?.trim() ||
      null
    );
  }
  if (p === "cursor") {
    return process.env.CURSOR_API_KEY?.trim() || null;
  }
  if (p === "ollama") return null;
  return null;
}

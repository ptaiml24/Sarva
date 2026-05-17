/**
 * Build an OpenAI-compatible chat completions URL from admin-configured base.
 * Accepts host root (e.g. http://127.0.0.1:11434) or .../v1 (common Ollama hint).
 */
export function openAiCompatibleChatCompletionsUrl(baseRaw: string): string {
  const b = baseRaw.trim().replace(/\/+$/, "");
  if (b.endsWith("/v1/chat/completions")) return b;
  if (b.endsWith("/v1")) return `${b}/chat/completions`;
  return `${b}/v1/chat/completions`;
}

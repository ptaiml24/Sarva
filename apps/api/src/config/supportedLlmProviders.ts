/**
 * Canonical list for Admin UI + docs. Model IDs are strings passed to provider adapters / HTTP APIs.
 * Credentials are usually stored on `LlmProviderConnection`; env vars remain as fallbacks for legacy paths.
 */
export type LlmProviderTemplate = {
  id: string;
  label: string;
  description: string;
  docsUrl?: string;
  /** Environment variables required on the API server to call this provider */
  requiredEnv: { name: string; description: string }[];
  optionalEnv?: { name: string; description: string }[];
  /** Common model ids for dropdowns; user may override with a custom id (Ollama tags, etc.) */
  modelPresets: { modelId: string; label: string }[];
  /** Hint shown after picking a preset */
  modelIdHint?: string;
};

export const SUPPORTED_LLM_PROVIDERS: LlmProviderTemplate[] = [
  {
    id: "openai",
    label: "OpenAI",
    description: "Hosted GPT models via the OpenAI API.",
    docsUrl: "https://platform.openai.com/docs/models",
    requiredEnv: [{ name: "OPENAI_API_KEY", description: "Secret key from OpenAI API keys page" }],
    optionalEnv: [
      { name: "OPENAI_BASE_URL", description: "Optional. Default https://api.openai.com/v1 — set for Azure OpenAI-compatible endpoints" },
    ],
    modelPresets: [
      { modelId: "gpt-4o", label: "gpt-4o" },
      { modelId: "gpt-4o-mini", label: "gpt-4o-mini" },
      { modelId: "o3-mini", label: "o3-mini" },
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    description: "Claude models via Anthropic API.",
    docsUrl: "https://docs.anthropic.com/en/docs/about-claude/models",
    requiredEnv: [{ name: "ANTHROPIC_API_KEY", description: "API key from Anthropic Console" }],
    modelPresets: [
      { modelId: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
      { modelId: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet" },
      { modelId: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku" },
    ],
  },
  {
    id: "google",
    label: "Google Gemini",
    description: "Gemini models (Google AI Studio / Vertex).",
    docsUrl: "https://ai.google.dev/gemini-api/docs/models/gemini",
    requiredEnv: [
      {
        name: "GOOGLE_GENERATIVE_AI_API_KEY",
        description: "API key from Google AI Studio (Gemini API)",
      },
    ],
    optionalEnv: [
      { name: "GOOGLE_AI_API_KEY", description: "Alternative env name some tools use — set one of these" },
    ],
    modelPresets: [
      { modelId: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
      { modelId: "gemini-2.5-pro-preview-03-25", label: "Gemini 2.5 Pro (preview)" },
      { modelId: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
    ],
    modelIdHint: "Use the exact model id from Google’s API; preview names change frequently.",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    description: "Run Llama, Mistral, Gemma, etc. locally via Ollama’s OpenAI-compatible API.",
    docsUrl: "https://ollama.com/library",
    requiredEnv: [],
    optionalEnv: [
      { name: "OLLAMA_BASE_URL", description: "Default http://127.0.0.1:11434 if unset" },
      {
        name: "OLLAMA_LIST_EXTRA_HOSTS",
        description:
          "Comma-separated extra hostnames allowed for GET /integrations/ollama-models (SSRF allowlist), e.g. myollama.internal",
      },
    ],
    modelPresets: [
      { modelId: "llama3.2", label: "Llama 3.2" },
      { modelId: "mistral", label: "Mistral" },
      { modelId: "gemma2", label: "Gemma 2" },
      { modelId: "qwen2.5", label: "Qwen 2.5" },
      { modelId: "phi3", label: "Phi-3" },
    ],
    modelIdHint: "Pull the model in Ollama first (`ollama pull llama3.2`). Use the same tag as `ollama list`.",
  },
  {
    id: "meta",
    label: "Meta Llama (API)",
    description: "Llama models via a hosted inference provider (configure base URL + token per vendor).",
    requiredEnv: [
      { name: "LLAMA_API_URL", description: "Base URL of the inference endpoint" },
      { name: "LLAMA_API_KEY", description: "Bearer token if required by the provider" },
    ],
    modelPresets: [
      { modelId: "Llama-3.3-70B-Instruct", label: "Llama 3.3 70B Instruct (example id)" },
      { modelId: "Llama-3.2-3B-Instruct", label: "Llama 3.2 3B Instruct (example id)" },
    ],
    modelIdHint: "Exact model id depends on your provider; this app stores the id string only — wiring to Meta/hosted APIs is env + future adapter work.",
  },
  {
    id: "cursor",
    label: "Cursor (Agent SDK)",
    description:
      "Same Cursor agent as the IDE/CLI via `@cursor/sdk` — local working tree or cloud against a Git HTTPS URL. Key: Cursor Dashboard → Integrations (or team service account).",
    docsUrl: "https://cursor.com/docs/api/sdk/typescript",
    requiredEnv: [
      {
        name: "CURSOR_API_KEY",
        description: "Fallback API key when the connection does not store one",
      },
    ],
    optionalEnv: [
      {
        name: "CURSOR_AGENT_LOCAL_CWD",
        description:
          "Absolute path on the API host for **local** SDK runs when no HTTPS repo URL is set on the connection (default: process.cwd())",
      },
      {
        name: "CURSOR_CLOUD_REPO_URL",
        description: "When set and connection Base URL is empty, use a **cloud** agent with this Git repository URL",
      },
      {
        name: "CURSOR_CLOUD_REPO_REF",
        description: "Git ref for cloud clone (default main)",
      },
    ],
    modelPresets: [
      { modelId: "auto", label: "Server default (auto)" },
      { modelId: "composer-2", label: "Composer 2" },
    ],
    modelIdHint:
      "Use `Cursor.models.list()` or docs; leave a preset or use **auto**. For cloud runs, set connection **Base URL** to an `https://` Git repo URL (or set CURSOR_CLOUD_REPO_URL on the API host).",
  },
];

/** All env var names we surface in the status endpoint (presence only, never values). */
export function allTrackedLlmEnvKeys(): string[] {
  const keys = new Set<string>();
  for (const p of SUPPORTED_LLM_PROVIDERS) {
    for (const e of p.requiredEnv) keys.add(e.name);
    for (const e of p.optionalEnv ?? []) keys.add(e.name);
  }
  keys.add("PM_PROPOSE_USE_LLM");
  keys.add("PM_PROPOSE_E2E_STUB");
  keys.add("PM_PLAN_BOARD_USE_LLM");
  keys.add("PM_PLAN_BOARD_E2E_STUB");
  keys.add("AGENT_CODER_USE_LLM");
  keys.add("AGENT_CODER_E2E_STUB");
  return [...keys].sort();
}
